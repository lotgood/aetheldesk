import os
from importlib import import_module
from typing import Any, cast

from fastapi import APIRouter
from fastapi.responses import FileResponse


def _backend_module(name: str) -> Any:
    try:
        return import_module(f"backend.{name}")
    except ModuleNotFoundError:
        return import_module(name)


_runtime = cast(Any, _backend_module("room_service")._runtime)


router = APIRouter()


@router.get("/")
async def lobby():
    runtime = _runtime()
    return FileResponse(os.path.join(runtime.FRONTEND, "lobby.html"))


@router.get("/room/{room_id}")
async def room_page(room_id: str):
    _ = room_id
    runtime = _runtime()
    return FileResponse(os.path.join(runtime.FRONTEND, "room.html"))
