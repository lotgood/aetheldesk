from pathlib import Path


def test_websocket_handler_delegates_room_mutation_and_cleanup_to_session_service():
    # Given: the WebSocket endpoint is the transport boundary.
    source = Path("backend/websocket_handler.py").read_text(encoding="utf-8")

    # When: its source is inspected for orchestration responsibilities.
    required_delegates = (
        "load_authorized_room_state",
        "process_room_client_message",
        "connect_room_websocket",
        "disconnect_room_websocket",
    )
    forbidden_inline_responsibilities = (
        "asyncio",
        "save_room_state",
        "publish_room_state",
        "schedule_cleanup",
        "stop_room_events",
        "broadcast_json",
    )

    # Then: persistence, fanout, publish, and cleanup are delegated.
    for delegate in required_delegates:
        assert delegate in source
    for responsibility in forbidden_inline_responsibilities:
        assert responsibility not in source
