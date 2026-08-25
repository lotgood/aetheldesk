from __future__ import annotations

from pathlib import Path
import re

import pytest
from playwright.sync_api import Browser, Page, expect


EVIDENCE_DIR = Path(__file__).resolve().parents[2] / ".omo" / "evidence"


def _create_via_lobby(page: Page, live_server: str, pin: str) -> str:
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill(pin)
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    room_id = page.url.rsplit("/", 1)[-1]
    expect(page.locator("#room-label")).to_contain_text(room_id)
    return room_id


def _join_from_lobby(page: Page, live_server: str, room_id: str, pin: str) -> None:
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#code-toggle").click()
    page.locator("#room-input").fill(room_id)
    page.locator("#pin-input").fill(pin)
    page.locator("#btn-join").click()
    expect(page).to_have_url(f"{live_server}/room/{room_id}")


def _token_for_room(page: Page, room_id: str) -> str:
    token = page.evaluate("(rid) => sessionStorage.getItem(`room_token:${rid}`)", room_id)
    assert token is not None and len(token) > 20
    return str(token)


def _local_storage_keys(page: Page) -> list[str]:
    return page.evaluate("() => Object.keys(localStorage)")


@pytest.mark.e2e
def test_two_client_sync_reload_reconnect_and_scene(browser: Browser, live_server: str) -> None:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    pin = "1234"

    context_a = browser.new_context()
    page_a = context_a.new_page()
    room_id = _create_via_lobby(page_a, live_server, pin)
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
    expect(page_a.locator("#idle-duration")).to_have_text("25:00")
    page_a.wait_for_function("() => document.body.dataset.mode === 'idle'")
    page_a.locator("#focus-btn").click()
    page_b.wait_for_function("() => document.getElementById('pomodoro').style.opacity === '1'")
    expect(page_b).to_have_title(re.compile(r"2[45]:[0-5][0-9].*집중.*AethelDesk"))
    page_b.screenshot(path=str(EVIDENCE_DIR / "task-12-two-client-focus.png"), full_page=True)

    expect(page_b.locator("#pom-time")).to_have_text(re.compile(r"2[45]:[0-5][0-9]"))

    pause_b = page_b.locator("#btn-pause-timer")
    expect(pause_b).to_be_visible()
    pause_b.click()
    expect(page_b).to_have_title(re.compile(r"2[45]:[0-5][0-9].*일시정지.*AethelDesk"))
    pause_b.click()
    expect(page_b).to_have_title(re.compile(r"2[45]:[0-5][0-9].*집중.*AethelDesk"))
    for page in (page_a, page_b):
        expect(page.locator("#music-bar, #btn-add-track, #yt-frame")).to_have_count(0)

    page_b.reload(wait_until="domcontentloaded")
    expect(page_b.locator("#room-auth")).to_be_hidden()
    expect(page_b.locator("#room-label")).to_contain_text(room_id)
    page_b.wait_for_function("() => document.getElementById('pomodoro').style.opacity === '1'")
    expect(page_b).to_have_title(re.compile(r"2[45]:[0-5][0-9].*집중.*AethelDesk"))
    page_b.screenshot(path=str(EVIDENCE_DIR / "task-12-reload-state.png"), full_page=True)

    page_a.reload(wait_until="domcontentloaded")
    expect(page_a.locator("#room-auth")).to_be_hidden()
    page_a.wait_for_function("() => document.getElementById('pomodoro').style.opacity === '1'")
    page_a.locator("#btn-cancel-timer").click()
    expect(page_a).to_have_title("AethelDesk")
    for selector in ("#focus-btn", "#time-dial", "#btn-copy-room", "#dur-chips", "#btn-reset-time"):
        assert page_a.locator(selector).get_attribute("tabindex") != "-1"
    expect(page_a.locator("#time-dial")).to_be_visible()

    page_a.evaluate(
        "() => { const slider = document.getElementById('time-slider'); slider.value = '555'; slider.dispatchEvent(new Event('input', { bubbles: true })); }"
    )
    expect(page_b.locator("#time-slider")).to_have_value("555")
    page_a.locator("#btn-reset-time").click()
    page_b.wait_for_function("() => document.getElementById('time-slider').value !== '555'")

    page_a.locator("#btn-scene").click()
    expect(page_a.locator("#scene-panel")).to_be_visible()
    page_a.locator('[data-scene="city"]').click()
    page_a.wait_for_function("() => document.body.dataset.scene === 'city' && localStorage.getItem('scene') === 'city'")
    expect(page_a.locator("#scene-label")).to_have_text("도시")
    local_keys = _local_storage_keys(page_a)
    assert "scene" in local_keys
    assert all(not key.startswith("room_token:") for key in local_keys)

    text_evidence = EVIDENCE_DIR / "task-12-sync-notes.txt"
    text_evidence.write_text(
        "\n".join(
            [
                f"room_id={room_id}",
                "verified=focus_toggle_via_#focus-btn,duration_primary_cta,tab_title_focus_pause_reload_idle,no_frontend_media_controls,time_override_reset,reload_state,reconnect_recovery,scene_picker_storage",
                "screenshots=task-12-two-client-focus.png,task-12-reload-state.png",
            ]
        ),
        encoding="utf-8",
    )

    context_a.close()
    context_b.close()


@pytest.mark.e2e
def test_focus_pause_timer_stays_clickable(browser: Browser, live_server: str) -> None:
    context = browser.new_context()
    page = context.new_page()
    _create_via_lobby(page, live_server, "2468")
    expect(page.locator("#focus-btn")).to_be_visible()
    expect(page.locator("#conn-copy")).to_have_text("연결됨")
    page.locator("#focus-btn").click()
    pause = page.locator("#btn-pause-timer")
    expect(pause).to_be_visible()
    expect(pause).to_have_text("일시정지")
    pause.click()
    expect(pause).to_have_text("재개")
    expect(page.locator("#timer-status")).to_contain_text("일시정지")
    evidence = Path(__file__).resolve().parents[2] / "artifacts" / "hardening"
    evidence.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(evidence / "pause-e2e.png"), full_page=True)
    context.close()
