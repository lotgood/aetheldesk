import asyncio
import logging
from collections.abc import Callable
from typing import Protocol

from backend import config
from backend.connection_manager import LocalConnectionManager
from backend.room_store import RedisUnavailable, RoomGenerationChanged
from backend.state import BackendState, advance_timer_state


logger = logging.getLogger("aetheldesk.scheduler")


class RoomStoreLike(Protocol):
    async def room_ids(self) -> tuple[str, ...]: ...
    async def get_state(self, room_id: str) -> BackendState | None: ...
    async def get_room_snapshot(self, room_id: str) -> tuple[BackendState, str] | None: ...
    async def set_state(self, room_id: str, state: BackendState) -> None: ...
    async def refresh_ttl(self, room_id: str) -> bool: ...
    async def acquire_tick_lock(self, room_id: str, owner: str, ttl_seconds: int) -> tuple[int, str] | None: ...
    async def complete_tick_lock(self, room_id: str, lease: str, ttl_seconds: int) -> bool: ...
    async def commit_tick_state(
        self,
        room_id: str,
        lease: str,
        expected_revision: int,
        expected_instance_id: str,
        state: BackendState,
        lock_seconds: int,
    ) -> bool: ...


class StatePublisher(Protocol):
    async def publish_state(self, room_id: str, state: BackendState) -> dict[str, object]: ...


CelestialProvider = Callable[[], dict[str, object]]


class RoomTickScheduler:
    def __init__(
        self,
        store: RoomStoreLike,
        *,
        connections: LocalConnectionManager,
        worker_id: str,
        celestial_provider: CelestialProvider,
        publisher: StatePublisher | None = None,
        lock_seconds: int = config.ROOM_TICK_LOCK_SECONDS,
    ) -> None:
        self.store = store
        self.connections = connections
        self.worker_id = worker_id
        self.celestial_provider = celestial_provider
        self.publisher = publisher
        self.lock_seconds = lock_seconds

    async def tick_once(self, *, counter: int) -> None:
        # Redis is the shared room registry. Iterating it keeps an active
        # focus/break cycle moving even while every browser is temporarily
        # disconnected. The local union also keeps small test/dev stores that
        # predate the registry contract working without hiding a live socket.
        room_ids = set(await self.store.room_ids())
        room_ids.update(self.connections.room_ids())
        for room_id in sorted(room_ids):
            try:
                await self.tick_room(room_id, counter=counter)
            except asyncio.CancelledError:
                raise
            except RedisUnavailable:
                raise
            except RoomGenerationChanged:
                continue
            except Exception:
                logger.exception("timer tick failed for room %s", room_id)

    async def tick_room(self, room_id: str, *, counter: int) -> bool:
        preliminary_snapshot = await self.store.get_room_snapshot(room_id)
        if preliminary_snapshot is None:
            return False
        preliminary_state, room_instance_id = preliminary_snapshot
        connected = self.connections.has_connections(room_id, room_instance_id)
        advancing = preliminary_state["break"] or (preliminary_state["focus"] and not preliminary_state["paused"])
        if not connected and not advancing:
            # Only a worker with a local browser should contend for an idle or
            # paused room. Running cycles remain globally tickable through the
            # shared registry; abandoned paused rooms may expire naturally.
            return True

        tick_lease = await self.store.acquire_tick_lock(room_id, self.worker_id, self.lock_seconds)
        if tick_lease is None:
            return False
        logical_slot, lease = tick_lease

        state: BackendState | None = None
        needs_broadcast = False
        lease_completed = False
        try:
            snapshot = await self.store.get_room_snapshot(room_id)
            if snapshot is None:
                return False
            state, room_instance_id = snapshot

            expected_revision = state["revision"]
            connected = self.connections.has_connections(room_id, room_instance_id)
            advancing = state["break"] or (state["focus"] and not state["paused"])
            if advancing:
                previous_slot = state["last_tick_slot"]
                elapsed_seconds = 1 if previous_slot is None else max(0, logical_slot - previous_slot)
                needs_broadcast = advance_timer_state(state, elapsed_seconds)
                still_advancing = state["break"] or (state["focus"] and not state["paused"])
                state["last_tick_slot"] = logical_slot if still_advancing else None
            if (connected or advancing) and logical_slot % 30 == 0 and state["time_override"] is None:
                state["celestial"] = self.celestial_provider()
                needs_broadcast = True

            if needs_broadcast:
                state["revision"] = expected_revision + 1
                lease_completed = await self.store.commit_tick_state(
                    room_id,
                    lease,
                    expected_revision,
                    room_instance_id,
                    state,
                    self.lock_seconds,
                )
                if not lease_completed:
                    return False
            elif connected or advancing:
                # Keep credentials alive for an advancing cycle and for people
                # who are still sitting in an idle or paused room. Disconnected
                # idle/paused rooms are deliberately left to natural expiry.
                await self.store.refresh_ttl(room_id)
        finally:
            if not lease_completed:
                await self.store.complete_tick_lock(room_id, lease, self.lock_seconds)

        if not needs_broadcast or state is None:
            return True
        await self.connections.broadcast_json(
            room_id,
            {"type": "state", "data": state},
            expected_instance_id=room_instance_id,
        )
        if self.publisher is not None:
            await self.publisher.publish_state(room_id, state)
        return True
