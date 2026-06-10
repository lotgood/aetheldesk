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
def test_two_clients_sync_ambience_controls(browser: Browser, live_server: str) -> None:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    room_id = _room_id("AMBI")
    pin = "2468"

    context_a = browser.new_context()
    context_b = browser.new_context()
    page_a = context_a.new_page()
    page_b = context_b.new_page()

    try:
        _create_via_lobby(page_a, live_server, room_id, pin)
        _join_from_lobby(page_b, live_server, room_id, pin)

        page_a.locator("#btn-ambience").click()
        expect(page_a.locator("#ambience-panel")).to_be_visible()
        page_a.locator("#ambience-enabled").check()
        page_a.locator("#ambience-rain").fill("45")
        page_a.locator("#ambience-rain").dispatch_event("input")
        page_a.locator("#ambience-brown-noise").fill("70")
        page_a.locator("#ambience-brown-noise").dispatch_event("input")

        page_b.locator("#btn-ambience").click()
        expect(page_b.locator("#ambience-enabled")).to_be_checked()
        expect(page_b.locator("#ambience-rain")).to_have_value("45")
        expect(page_b.locator("#ambience-brown-noise")).to_have_value("70")

        page_b.reload(wait_until="domcontentloaded")
        page_b.locator("#btn-ambience").click()
        expect(page_b.locator("#ambience-enabled")).to_be_checked()
        expect(page_b.locator("#ambience-rain")).to_have_value("45")

        page_b.screenshot(path=str(EVIDENCE_DIR / "task-4-ambience-sync.png"), full_page=True)
    finally:
        context_a.close()
        context_b.close()
