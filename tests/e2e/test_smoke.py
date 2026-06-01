import pytest
from typing import Any


@pytest.mark.e2e
def test_smoke_lobby_and_room_render(page: Any, live_server: str) -> None:
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    assert page.locator("#btn-start").is_visible()

    page.goto(f"{live_server}/room/E2ESMOKE", wait_until="domcontentloaded")
    room_label = page.locator("#room-label")
    assert room_label.is_visible()
    assert "E2ESMOKE" in room_label.inner_text(timeout=5_000)
