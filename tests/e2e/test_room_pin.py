from __future__ import annotations

import re
from typing import Any

import pytest
from playwright.sync_api import Browser, expect


def _create_room(page: Any, live_server: str, pin: str) -> str:
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill(pin)
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    return str(page.url.rsplit("/", 1)[-1])


def _read_storage(page: Any, room_id: str) -> tuple[str | None, list[str]]:
    token = page.evaluate(
        "(rid) => sessionStorage.getItem(`room_token:${rid}`)",
        room_id,
    )
    local_keys = page.evaluate("() => Object.keys(localStorage)")
    return token, local_keys


@pytest.mark.e2e
def test_room_pin_create_wrong_and_correct_join(browser: Browser, live_server: str) -> None:
    pin = "1234"

    creator_context = browser.new_context()
    creator_page = creator_context.new_page()
    room_id = _create_room(creator_page, live_server, pin)
    token, local_keys = _read_storage(creator_page, room_id)
    assert token is not None and len(token) > 20
    assert all("token" not in key.lower() and "pin" not in key.lower() for key in local_keys)

    wrong_context = browser.new_context()
    wrong_page = wrong_context.new_page()
    wrong_page.goto(f"{live_server}/", wait_until="domcontentloaded")
    wrong_page.locator("#code-toggle").click()
    wrong_page.locator("#room-input").fill(room_id)
    wrong_page.locator("#pin-input").fill("9999")
    wrong_page.locator("#btn-join").click()
    expect(wrong_page.locator("#lobby-error")).to_have_text("입장할 수 없습니다")
    wrong_token, wrong_local_keys = _read_storage(wrong_page, room_id)
    assert wrong_token is None
    assert all("token" not in key.lower() and "pin" not in key.lower() for key in wrong_local_keys)

    join_context = browser.new_context()
    join_page = join_context.new_page()
    join_page.goto(f"{live_server}/", wait_until="domcontentloaded")
    join_page.locator("#code-toggle").click()
    join_page.locator("#room-input").fill(room_id)
    join_page.locator("#pin-input").fill(pin)
    join_page.locator("#btn-join").click()
    expect(join_page).to_have_url(f"{live_server}/room/{room_id}")
    join_token, join_local_keys = _read_storage(join_page, room_id)
    assert join_token is not None and len(join_token) > 20
    assert all("token" not in key.lower() and "pin" not in key.lower() for key in join_local_keys)

    creator_context.close()
    wrong_context.close()
    join_context.close()
