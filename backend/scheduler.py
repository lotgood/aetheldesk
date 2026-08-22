from collections.abc import Callable
from typing import Protocol

from backend import config
from backend.connection_manager import LocalConnectionManager
from backend.state import BackendState, advance_timer_state


class RoomStoreLike(Protocol):
    async def get_state(self, room_id: str) -> BackendState | None: ...
    async def set_state(self, room_id: str, state: BackendState) -> None: ...
    async def acquire_tick_lock(self, room_id: str, owner: str, ttl_seconds: int) -> bool: ...


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
        for room_id in self.connections.room_ids():
            await self.tick_room(room_id, counter=counter)

    async def tick_room(self, room_id: str, *, counter: int) -> bool:
        acquired = await self.store.acquire_tick_lock(room_id, self.worker_id, self.lock_seconds)
        if not acquired:
            return False

        state = await self.store.get_state(room_id)
        if state is None:
            return False

        needs_broadcast = advance_timer_state(state)
        if counter % 30 == 0 and state["time_override"] is None:
            state["celestial"] = self.celestial_provider()
            needs_broadcast = True

        if not needs_broadcast:
            return True

        await self.store.set_state(room_id, state)
        await self.connections.broadcast_json(room_id, {"type": "state", "data": state})
        if self.publisher is not None:
            await self.publisher.publish_state(room_id, state)
        return True
