from __future__ import annotations

from pathlib import Path
from uuid import uuid4

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


def _join_from_lobby(page: Page, live_server: str, room_id: str, pin: str) -> None:
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#code-toggle").click()
    page.locator("#room-input").fill(room_id)
    page.locator("#pin-input").fill(pin)
    page.locator("#btn-start").click()
    expect(page).to_have_url(f"{live_server}/room/{room_id}")


@pytest.mark.e2e
def test_scene_selection_syncs_and_overrides_local_preference(browser: Browser, live_server: str) -> None:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    room_id = _room_id("SCENE")
    pin = "2468"

    context_a = browser.new_context()
    context_b = browser.new_context()
    page_a = context_a.new_page()
    page_b = context_b.new_page()

    try:
        _create_via_lobby(page_a, live_server, room_id, pin)
        _join_from_lobby(page_b, live_server, room_id, pin)

        page_a.locator("#btn-scene").click()
        expect(page_a.locator("#scene-menu")).to_be_visible()
        page_a.locator('[data-scene-option="city"]').click()

        expect(page_b.locator("body")).to_have_attribute("data-scene", "city")
        expect(page_b.locator("#scene-options")).to_contain_text("현재 선택은 도시")

        page_b.evaluate("() => localStorage.setItem('scene', 'forest')")
        page_b.reload(wait_until="domcontentloaded")
        expect(page_b.locator("body")).to_have_attribute("data-scene", "city")
        expect(page_b.locator("#scene-options")).to_contain_text("현재 선택은 도시")

        page_b.screenshot(path=str(EVIDENCE_DIR / "task-3-scene-shared.png"), full_page=True)
    finally:
        context_a.close()
        context_b.close()
