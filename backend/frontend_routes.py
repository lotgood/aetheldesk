import os
from importlib import import_module
from typing import Any, cast

from fastapi import APIRouter
from fastapi.responses import FileResponse

_runtime = cast(Any, import_module("backend.room_service")._runtime)


router = APIRouter()


def _frontend_file(filename: str) -> str:
    runtime = _runtime()
    built_path = os.path.join(runtime.FRONTEND_DIST, filename)
    if os.path.exists(built_path):
        return built_path
    return os.path.join(runtime.FRONTEND, filename)


@router.get("/")
async def lobby():
    return FileResponse(_frontend_file("lobby.html"), headers={"Cache-Control": "no-cache"})


@router.get("/room/{room_id}")
async def room_page(room_id: str):
    _ = room_id
    return FileResponse(_frontend_file("room.html"), headers={"Cache-Control": "no-cache"})
