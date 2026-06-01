import asyncio
from contextlib import asynccontextmanager, suppress
from importlib import import_module
from typing import Any, cast

from fastapi import FastAPI


def _backend_module(name: str) -> Any:
    try:
        return import_module(f"backend.{name}")
    except ModuleNotFoundError:
        return import_module(name)


_room_service = _backend_module("room_service")
_runtime = cast(Any, _room_service._runtime)
initialize_store_and_events = cast(Any, _room_service.initialize_store_and_events)
stop_event_subscriptions = cast(Any, _room_service.stop_event_subscriptions)


@asynccontextmanager
async def lifespan(app: FastAPI):
    del app
    runtime = _runtime()
    await initialize_store_and_events()
    task = asyncio.create_task(runtime.tick())
    try:
        yield
    finally:
        await stop_event_subscriptions()
        _ = task.cancel()
        with suppress(asyncio.CancelledError):
            await task
