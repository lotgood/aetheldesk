import importlib
import inspect
from pathlib import Path
from collections.abc import Callable
from types import ModuleType
from typing import Any, cast, get_type_hints


PRIVATE_AUTH_HELPERS = (
    "_assert_not_rate_limited",
    "_auth_failure",
    "_client_fingerprint",
    "_generated_room_id",
    "_issue_room_token",
    "_new_room_instance_id",
    "_record_failed_attempt",
    "_require_valid_room_id",
)

ROOM_AUTH_PUBLIC_FUNCTIONS = (
    "assert_not_rate_limited",
    "auth_failure",
    "client_fingerprint",
    "generated_room_id",
    "issue_room_token",
    "new_room_instance_id",
    "record_failed_attempt",
    "require_valid_room_id",
    "token_authorizes_room",
)

ROOM_LIFECYCLE_PUBLIC_FUNCTIONS = (
    "create_room_with_pin",
    "join_room_with_pin",
    "verify_existing_pin",
)


def _public_functions(module: ModuleType, names: tuple[str, ...]) -> list[Callable[..., object]]:
    return [cast(Callable[..., object], getattr(module, name)) for name in names]


def test_room_routes_use_public_auth_and_lifecycle_services():
    source = Path("backend/room_routes.py").read_text(encoding="utf-8")

    assert '_backend_module("room_service")' not in source
    assert "room_auth_service" in source
    assert "room_lifecycle" in source
    for helper in PRIVATE_AUTH_HELPERS:
        assert helper not in source


def test_public_room_service_functions_are_typed_without_any():
    room_auth_service = importlib.import_module("backend.room_auth_service")
    room_lifecycle = importlib.import_module("backend.room_lifecycle")
    functions = (
        *_public_functions(room_auth_service, ROOM_AUTH_PUBLIC_FUNCTIONS),
        *_public_functions(room_lifecycle, ROOM_LIFECYCLE_PUBLIC_FUNCTIONS),
    )

    for function in functions:
        signature = inspect.signature(function)
        hints = get_type_hints(function)
        assert signature.return_annotation is not inspect.Signature.empty
        assert hints.get("return") is not Any
        for parameter in signature.parameters.values():
            assert parameter.annotation is not inspect.Signature.empty
            assert hints.get(parameter.name) is not Any
