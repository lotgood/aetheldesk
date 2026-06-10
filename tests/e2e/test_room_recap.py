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
    expect(page.locator("#conn-status")).to_contain_text("방이 연결되었습니다")


@pytest.mark.e2e
def test_room_recap_updates_task_metric_and_survives_reload(browser: Browser, live_server: str) -> None:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    room_id = _room_id("RECAP")
    pin = "2468"

    context = browser.new_context()
    page = context.new_page()

    try:
        _create_via_lobby(page, live_server, room_id, pin)
        expect(page.locator("#room-recap")).to_contain_text("완료 0개")

        page.locator("#intent-task-input").fill("초안 작성")
        page.locator("#intent-task-add").click()
        expect(page.locator("#intent-task-list")).to_contain_text("초안 작성")
        page.locator(".intent-task-action").first.click()
        expect(page.locator("#room-recap")).to_contain_text("완료 1개")

        page.reload(wait_until="domcontentloaded")
        expect(page.locator("#room-recap")).to_contain_text("완료 1개")

        page.screenshot(path=str(EVIDENCE_DIR / "task-5-room-recap.png"), full_page=True)
    finally:
        context.close()
