from __future__ import annotations

import re

import pytest
from playwright.sync_api import Browser, ConsoleMessage, Page, ViewportSize, expect


SCENES = {
    "sky": ("", "해변 하늘"),
    "city": ("city", "도시"),
    "forest": ("forest", "숲"),
}

MOBILE_SCENE_VIEWPORTS = (
    ({"width": 390, "height": 844}, 3),
    ({"width": 844, "height": 390}, 2),
    ({"width": 1024, "height": 768}, 2),
)


def _create_room(page: Page, live_server: str) -> str:
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    room_id = page.url.rsplit("/", 1)[-1]
    expect(page.locator("#room-label")).to_contain_text(room_id)
    expect(page.locator("#conn-copy")).to_have_text("연결됨")
    return room_id


@pytest.mark.e2e
def test_retired_beach_preference_migrates_to_the_unified_coast(browser: Browser, live_server: str) -> None:
    context = browser.new_context()
    page = context.new_page()
    page.add_init_script("localStorage.setItem('scene', 'beach')")

    _create_room(page, live_server)

    page.wait_for_function("() => localStorage.getItem('scene') === 'sky'")
    expect(page.locator("#scene-label")).to_have_text("해변 하늘")
    expect(page.locator('.scene-option[data-scene="sky"]')).to_have_attribute("aria-pressed", "true")
    expect(page.locator('.scene-option[data-scene="beach"]')).to_have_count(0)
    context.close()


@pytest.mark.e2e
def test_scene_picker_switches_all_scenes_without_page_or_console_errors(browser: Browser, live_server: str) -> None:
    context = browser.new_context()
    page = context.new_page()
    page_errors: list[str] = []
    console_errors: list[str] = []

    page.on("pageerror", lambda error: page_errors.append(str(error)))

    def record_console_error(message: ConsoleMessage) -> None:
        if message.type == "error":
            console_errors.append(message.text)

    page.on("console", record_console_error)
    room_id = _create_room(page, live_server)

    expect(page.locator("#btn-copy-room")).to_be_visible()
    page.locator("#btn-copy-room").click()
    expect(page.locator("#room-status")).to_contain_text(room_id)

    for scene, (body_scene, label) in SCENES.items():
        page.locator("#btn-scene").click()
        panel = page.locator("#scene-panel")
        expect(panel).to_be_visible()
        option = panel.locator(f'button.scene-option[data-scene="{scene}"]')
        option.click()
        page.wait_for_function(
            "([expectedBody, expectedStored]) => "
            "document.body.dataset.scene === expectedBody && "
            "localStorage.getItem('scene') === expectedStored",
            arg=[body_scene, scene],
        )
        expect(page.locator("#scene-label")).to_have_text(label)
        expect(option).to_have_attribute("aria-pressed", "true")
        expect(panel).to_be_hidden()
        page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")

    assert page_errors == [], f"scene page errors: {page_errors}"
    assert console_errors == [], f"scene console errors: {console_errors}"
    context.close()


@pytest.mark.e2e
def test_every_scene_renders_at_noon_and_midnight_without_webgl_errors(browser: Browser, live_server: str) -> None:
    context = browser.new_context(viewport={"width": 1280, "height": 720}, reduced_motion="reduce")
    page = context.new_page()
    page_errors: list[str] = []
    console_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    _create_room(page, live_server)

    for minute, value_text in (("720", "12:00"), ("0", "00:00")):
        page.locator("#time-slider").fill(minute)
        expect(page.locator("#time-slider")).to_have_attribute("aria-valuetext", value_text)
        for scene, (body_scene, label) in SCENES.items():
            page.locator("#btn-scene").click()
            page.locator(f'.scene-option[data-scene="{scene}"]').click()
            page.wait_for_function(
                "([expectedBody, expectedStored]) => "
                "document.body.dataset.scene === expectedBody && "
                "localStorage.getItem('scene') === expectedStored",
                arg=[body_scene, scene],
            )
            expect(page.locator("#scene-label")).to_have_text(label)
            page.wait_for_timeout(250)

    assert page.locator("#aethel-3d-canvas").is_visible()
    assert page_errors == [], f"day/night scene page errors: {page_errors}"
    assert console_errors == [], f"day/night scene console errors: {console_errors}"
    context.close()


@pytest.mark.e2e
@pytest.mark.parametrize(("viewport", "device_scale_factor"), MOBILE_SCENE_VIEWPORTS)
def test_scene_picker_and_all_scenes_fit_touch_viewports(
    browser: Browser,
    live_server: str,
    viewport: ViewportSize,
    device_scale_factor: float,
) -> None:
    context = browser.new_context(
        viewport=viewport,
        device_scale_factor=device_scale_factor,
        has_touch=True,
        is_mobile=True,
        reduced_motion="reduce",
    )
    page = context.new_page()
    page_errors: list[str] = []
    console_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    _create_room(page, live_server)

    for scene, (body_scene, label) in SCENES.items():
        page.locator("#btn-scene").click()
        panel_box = page.locator("#scene-panel").bounding_box()
        assert panel_box is not None
        assert panel_box["x"] >= -0.5
        assert panel_box["y"] >= -0.5
        assert panel_box["x"] + panel_box["width"] <= viewport["width"] + 0.5
        assert panel_box["y"] + panel_box["height"] <= viewport["height"] + 0.5

        option = page.locator(f'.scene-option[data-scene="{scene}"]')
        option_box = option.bounding_box()
        assert option_box is not None and option_box["height"] >= 44
        option.click()
        page.wait_for_function(
            "([expectedBody, expectedStored]) => "
            "document.body.dataset.scene === expectedBody && "
            "localStorage.getItem('scene') === expectedStored",
            arg=[body_scene, scene],
        )
        expect(page.locator("#scene-label")).to_have_text(label)

    metrics = page.evaluate(
        "() => ({"
        "  coarse: matchMedia('(pointer: coarse)').matches,"
        "  bodyHeight: document.body.getBoundingClientRect().height,"
        "  scrollHeight: document.documentElement.scrollHeight,"
        "  canvas: document.getElementById('aethel-3d-canvas').getBoundingClientRect().toJSON()"
        "})"
    )
    assert metrics["coarse"] is True
    assert abs(metrics["bodyHeight"] - viewport["height"]) <= 0.5
    assert metrics["scrollHeight"] == viewport["height"]
    assert abs(metrics["canvas"]["width"] - viewport["width"]) <= 0.5
    assert abs(metrics["canvas"]["height"] - viewport["height"]) <= 0.5
    assert page_errors == [], f"mobile scene page errors: {page_errors}"
    assert console_errors == [], f"mobile scene console errors: {console_errors}"
    context.close()
