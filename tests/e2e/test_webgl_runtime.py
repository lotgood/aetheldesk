from __future__ import annotations

import re

import pytest
from playwright.sync_api import Browser, ConsoleMessage, expect


@pytest.mark.e2e
def test_unified_coast_suppresses_only_the_unstable_bloom_pass_and_restores_it(
    browser: Browser,
    live_server: str,
) -> None:
    context = browser.new_context(viewport={"width": 1280, "height": 720})
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    expect(page.locator("#conn-copy")).to_have_text("연결됨")
    page.wait_for_function("() => document.body.classList.contains('is-3d')")

    page.wait_for_function(
        "() => document.body.dataset.scene === ''"
        " && document.getElementById('aethel-3d-canvas').dataset.bloomActive === 'false'"
    )
    assert page.locator("#fx-bloom").get_attribute("aria-pressed") == "true"
    assert page.locator("#aethel-3d-canvas").get_attribute("data-bloom-suppressed") == "true"

    page.locator("#btn-scene").click()
    page.locator('.scene-option[data-scene="city"]').click()
    page.wait_for_function(
        "() => document.body.dataset.scene === 'city'"
        " && document.getElementById('aethel-3d-canvas').dataset.bloomActive === 'true'"
    )
    assert page.locator("#fx-bloom").get_attribute("aria-pressed") == "true"
    assert page.locator("#aethel-3d-canvas").get_attribute("data-bloom-suppressed") == "false"

    page.locator("#btn-scene").click()
    page.locator('.scene-option[data-scene="sky"]').click()
    page.wait_for_function(
        "() => document.body.dataset.scene === ''"
        " && document.getElementById('aethel-3d-canvas').dataset.bloomActive === 'false'"
    )
    assert page.locator("#aethel-3d-canvas").get_attribute("data-bloom-suppressed") == "true"
    context.close()


@pytest.mark.e2e
def test_runtime_webgl_context_loss_reveals_the_complete_2d_fallback(
    browser: Browser,
    live_server: str,
) -> None:
    context = browser.new_context(viewport={"width": 1280, "height": 720}, reduced_motion="reduce")
    page = context.new_page()
    page_errors: list[str] = []
    console_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))

    def record_console_error(message: ConsoleMessage) -> None:
        if message.type == "error":
            console_errors.append(message.text)

    page.on("console", record_console_error)
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    expect(page.locator("#conn-copy")).to_have_text("연결됨")
    expect(page.locator("#aethel-3d-canvas")).to_be_visible()
    page.wait_for_function("() => document.body.classList.contains('is-3d')")

    extension_available = page.locator("#aethel-3d-canvas").evaluate(
        """canvas => {
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          const extension = gl && gl.getExtension('WEBGL_lose_context');
          if (!extension) return false;
          extension.loseContext();
          return true;
        }"""
    )
    if not extension_available:
        context.close()
        pytest.skip("Chromium did not expose WEBGL_lose_context")

    page.wait_for_function(
        "() => !document.body.classList.contains('is-3d') && !document.getElementById('aethel-3d-canvas')"
    )
    expect(page.locator("#room-status")).to_contain_text("3D 장면에 문제가 있어")
    expect(page.locator("#sky")).to_be_visible()

    assert page_errors == []
    assert any("Fatal context-lost failure" in message for message in console_errors)
    context.close()
