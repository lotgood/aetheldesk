import asyncio
from importlib import import_module
from typing import Any, cast

from backend.scheduler import RoomTickScheduler
from backend.state import advance_timer_state

_room_service = import_module("backend.room_service")
_runtime = cast(Any, _room_service._runtime)
broadcast = cast(Any, _room_service.broadcast)


async def tick():
    runtime = _runtime()
    counter = 0
    while True:
        await asyncio.sleep(1)
        counter += 1
        if runtime.room_store is not None:
            scheduler = RoomTickScheduler(
                runtime.room_store,
                connections=runtime.connections,
                worker_id=runtime.worker_id,
                celestial_provider=runtime.get_celestial_state,
                publisher=runtime.event_bus,
            )
            await scheduler.tick_once(counter=counter)
            continue

        for room in list(runtime.rooms.values()):
            if not room["clients"]:
                continue
            state = room["state"]
            needs_broadcast = advance_timer_state(state)

            if counter % 30 == 0 and state["time_override"] is None:
                state["celestial"] = runtime.get_celestial_state()
                needs_broadcast = True

            if needs_broadcast:
                await broadcast(room, {"type": "state", "data": state})
