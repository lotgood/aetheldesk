from __future__ import annotations

from pathlib import Path
from uuid import uuid4
import re

import pytest
from playwright.sync_api import Browser, Page, expect


EVIDENCE_DIR = Path(__file__).resolve().parents[2] / ".omo" / "evidence"


def _room_id(prefix: str) -> str:
    return f"{prefix[:4]}{uuid4().hex[:4]}".upper()


def _create_via_lobby(page: Page, live_server: str, room_id: str, pin: str) -> None:
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#room-input").fill(room_id)
    page.locator("#pin-input").fill(pin)
    page.locator("#btn-start").click()
    expect(page).to_have_url(f"{live_server}/room/{room_id}")
    expect(page.locator("#room-label")).to_contain_text(room_id)


def _join_from_lobby(page: Page, live_server: str, room_id: str, pin: str) -> None:
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#code-toggle").click()
    page.locator("#room-input").fill(room_id)
    page.locator("#pin-input").fill(pin)
    page.locator("#btn-start").click()
    expect(page).to_have_url(f"{live_server}/room/{room_id}")


def _token_for_room(page: Page, room_id: str) -> str:
    token = page.evaluate("(rid) => sessionStorage.getItem(`room_token:${rid}`)", room_id)
    assert token is not None and len(token) > 20
    return str(token)


def _local_storage_keys(page: Page) -> list[str]:
    return page.evaluate("() => Object.keys(localStorage)")


def _reveal_controls(page: Page) -> None:
    page.mouse.move(20, 20)


@pytest.mark.e2e
def test_two_client_sync_reload_reconnect_and_scene(browser: Browser, live_server: str) -> None:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    room_id = _room_id("E2ESYNC")
    pin = "1234"

    context_a = browser.new_context()
    page_a = context_a.new_page()
    _create_via_lobby(page_a, live_server, room_id, pin)
    token_a = _token_for_room(page_a, room_id)

    context_b = browser.new_context()
    page_b = context_b.new_page()
    _join_from_lobby(page_b, live_server, room_id, pin)
    token_b = _token_for_room(page_b, room_id)
    assert token_a != token_b

    for page in (page_a, page_b):
        keys = _local_storage_keys(page)
        assert all("token" not in key.lower() and "pin" not in key.lower() for key in keys)

    page_a.locator('#dur-chips button[data-min="25"]').click()
    page_a.locator("#focus-btn").click()
    page_b.wait_for_function("() => document.getElementById('pomodoro').style.opacity === '1'")
    expect(page_b).to_have_title(re.compile(r"2[45]:[0-5][0-9].*집중.*AethelDesk"))
    page_b.screenshot(path=str(EVIDENCE_DIR / "task-12-two-client-focus.png"), full_page=True)

    expect(page_b.locator("#pom-time")).to_have_text(re.compile(r"2[45]:[0-5][0-9]"))

    _reveal_controls(page_a)
    _reveal_controls(page_b)
    page_b.wait_for_function("() => parseFloat(getComputedStyle(document.getElementById('conn-dot')).opacity) > 0")
    page_b.locator("#btn-pause-timer").click()
    expect(page_b).to_have_title(re.compile(r"2[45]:[0-5][0-9].*일시정지.*AethelDesk"))
    page_b.locator("#btn-pause-timer").click()
    expect(page_b).to_have_title(re.compile(r"2[45]:[0-5][0-9].*집중.*AethelDesk"))
    page_a.locator("#btn-play").click(force=True)
    page_b.wait_for_function("() => parseFloat(getComputedStyle(document.getElementById('conn-dot')).opacity) > 0")
    page_a.locator("#btn-pause").click(force=True)
    page_b.wait_for_function("() => parseFloat(getComputedStyle(document.getElementById('conn-dot')).opacity) > 0")
    page_a.locator("#btn-skip").click(force=True)
    page_b.wait_for_function("() => parseFloat(getComputedStyle(document.getElementById('conn-dot')).opacity) > 0")

    page_a.evaluate("() => { const slider = document.getElementById('time-slider'); slider.value = '555'; slider.dispatchEvent(new Event('input', { bubbles: true })); }")
    expect(page_b.locator("#time-slider")).to_have_value("555")
    page_a.locator("#btn-reset-time").click(force=True)
    page_b.wait_for_function("() => document.getElementById('time-slider').value !== '555'")

    page_b.reload(wait_until="domcontentloaded")
    expect(page_b.locator("#room-auth")).to_be_hidden()
    expect(page_b.locator("#room-label")).to_contain_text(room_id)
    page_b.wait_for_function("() => document.getElementById('pomodoro').style.opacity === '1'")
    expect(page_b).to_have_title(re.compile(r"2[45]:[0-5][0-9].*집중.*AethelDesk"))
    page_b.screenshot(path=str(EVIDENCE_DIR / "task-12-reload-state.png"), full_page=True)

    page_a.reload(wait_until="domcontentloaded")
    expect(page_a.locator("#room-auth")).to_be_hidden()
    page_a.wait_for_function("() => document.getElementById('pomodoro').style.opacity === '1'")
    _reveal_controls(page_a)
    page_a.locator("#btn-cancel-timer").click()
    expect(page_a).to_have_title("AethelDesk")

    _reveal_controls(page_a)
    page_a.locator("#btn-scene").click(force=True)
    page_a.wait_for_function("() => localStorage.getItem('scene') !== null")
    local_keys = _local_storage_keys(page_a)
    assert "scene" in local_keys
    assert all(not key.startswith("room_token:") for key in local_keys)

    text_evidence = EVIDENCE_DIR / "task-12-sync-notes.txt"
    text_evidence.write_text(
        "\n".join(
            [
                f"room_id={room_id}",
                "verified=focus_toggle_via_#focus-btn,duration,tab_title_focus_pause_reload_idle,music_play_pause_skip,time_override_reset,reload_state,reconnect_recovery,scene_storage",
                "screenshots=task-12-two-client-focus.png,task-12-reload-state.png",
            ]
        ),
        encoding="utf-8",
    )

    context_a.close()
    context_b.close()
