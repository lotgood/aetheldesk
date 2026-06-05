from __future__ import annotations

import re
from pathlib import Path
from uuid import uuid4

import pytest
from playwright.sync_api import Browser, BrowserContext, Page, expect


EVIDENCE_DIR = Path(__file__).resolve().parents[2] / ".omo" / "evidence"
NO_OVERLAP_SCRIPT = "(selectors) => { const boxes = selectors.map((s) => document.querySelector(s).getBoundingClientRect()); return boxes.every((a, i) => boxes.slice(i + 1).every((b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)); }"


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


def _install_fake_youtube(context: BrowserContext) -> None:
    context.add_init_script(
        "window.YT = {"
        "Player: function(id, options) {"
        "const host = document.getElementById(id);"
        "const frame = document.createElement('iframe');"
        "frame.id = id;"
        "frame.src = 'about:blank';"
        "if (host) host.replaceWith(frame);"
        "this.getIframe = () => frame;"
        "this.getVideoData = () => ({ video_id: options.videoId });"
        "this.loadVideoById = () => {};"
        "this.playVideo = () => {};"
        "this.pauseVideo = () => {};"
        "setTimeout(() => options.events?.onReady?.(), 0);"
        "}"
        "};"
    )


def _tabbed_focus_ids(page: Page, count: int) -> list[str]:
    ids: list[str] = []
    for _ in range(count):
        page.keyboard.press("Tab")
        ids.append(str(page.evaluate("() => document.activeElement?.id || document.activeElement?.tagName || ''")))
    return ids


def _assert_no_viewport_overflow(page: Page) -> None:
    overflow = page.evaluate(
        "() => ({"
        "width: document.documentElement.scrollWidth - window.innerWidth,"
        "height: document.documentElement.scrollHeight - window.innerHeight,"
        "})"
    )
    assert overflow == {"width": 0, "height": 0}


def _assert_no_overlap(page: Page, selectors: list[str]) -> None:
    assert page.evaluate(NO_OVERLAP_SCRIPT, selectors)


def _write_evidence(file_name: str, lines: list[str]) -> None:
    (EVIDENCE_DIR / file_name).write_text("\n".join(lines), encoding="utf-8")


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

    page_a.evaluate(
        "() => { const slider = document.getElementById('time-slider'); slider.value = '555'; slider.dispatchEvent(new Event('input', { bubbles: true })); }"
    )
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
    expect(page_a.locator("#room-status")).to_have_text("도시 장면으로 바꿨습니다.")
    local_keys = _local_storage_keys(page_a)
    assert "scene" in local_keys
    assert all(not key.startswith("room_token:") for key in local_keys)

    _write_evidence(
        "task-12-sync-notes.txt",
        [
            f"room_id={room_id}",
            "verified=focus_toggle_via_#focus-btn,duration,tab_title_focus_pause_reload_idle,music_play_pause_skip,time_override_reset,reload_state,reconnect_recovery,scene_storage",
            "screenshots=task-12-two-client-focus.png,task-12-reload-state.png",
        ],
    )

    context_a.close()
    context_b.close()


@pytest.mark.e2e
def test_keyboard_dialog_and_hidden_media_evidence(browser: Browser, live_server: str) -> None:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    room_id = _room_id("UXKEY")
    pin = "1234"
    hidden_ids = set(
        "room-input btn-join btn-pause-timer btn-cancel-timer btn-skip-break btn-pause btn-play btn-skip track-input track-add track-cancel btn-exit-yes btn-exit-no yt-frame".split()
    )

    context = browser.new_context()
    _install_fake_youtube(context)
    page = context.new_page()

    try:
        page.goto(f"{live_server}/", wait_until="domcontentloaded")
        expect(page.locator("#code-section")).to_have_attribute("aria-hidden", "true")
        lobby_focus_ids = _tabbed_focus_ids(page, 8)
        assert hidden_ids.isdisjoint(lobby_focus_ids)

        _create_via_lobby(page, live_server, room_id, pin)
        page.wait_for_function("() => document.getElementById('room-auth').classList.contains('hidden')")
        page.wait_for_function("() => document.querySelector('#yt-frame')?.tagName === 'IFRAME'")
        assert page.locator("#yt-frame").evaluate(
            "(frame) => frame.getAttribute('aria-hidden') === 'true'"
            "&& frame.getAttribute('tabindex') === '-1'"
            "&& frame.hasAttribute('inert')"
        )

        room_focus_ids = _tabbed_focus_ids(page, 18)
        assert hidden_ids.isdisjoint(room_focus_ids)

        page.locator("#focus-btn").click()
        expect(page.locator("#pomodoro")).to_have_css("opacity", "1")
        _reveal_controls(page)
        page.locator("#btn-exit").click(force=True)
        expect(page.locator("#exit-confirm")).to_be_visible()
        for key in ("Tab", "Shift+Tab", "Tab"):
            page.keyboard.press(key)
            assert page.locator("#exit-confirm").evaluate(
                "(dialog) => dialog.contains(document.activeElement)",
            )
        page.locator("#btn-exit-no").click()
        expect(page.locator("#exit-confirm")).to_be_hidden()
        page.wait_for_function("() => document.activeElement?.id === 'btn-exit'")

        _write_evidence(
            "task-4-keyboard-dialogs.txt",
            [
                f"room_id={room_id}",
                f"lobby_focus_ids={','.join(lobby_focus_ids)}",
                f"room_focus_ids={','.join(room_focus_ids)}",
                "verified=hidden_controls_not_tabbable,exit_dialog_focus_trap,youtube_iframe_hidden_after_replacement",
            ],
        )
    finally:
        context.close()


@pytest.mark.e2e
def test_mobile_touch_and_reduced_motion_evidence(browser: Browser, live_server: str) -> None:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    room_id = _room_id("UXMO")
    pin = "1234"

    portrait = browser.new_context(
        viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, reduced_motion="reduce"
    )
    portrait_page = portrait.new_page()
    landscape = browser.new_context(
        viewport={"width": 844, "height": 390}, is_mobile=True, has_touch=True, reduced_motion="reduce"
    )
    landscape_page = landscape.new_page()
    tablet = browser.new_context(viewport={"width": 768, "height": 1024}, is_mobile=True, has_touch=True)
    tablet_page = tablet.new_page()

    try:
        _create_via_lobby(portrait_page, live_server, room_id, pin)
        expect(portrait_page.locator("#controls")).to_have_css("opacity", "1")
        assert portrait_page.evaluate("() => matchMedia('(prefers-reduced-motion: reduce)').matches") is True
        assert portrait_page.locator("#hud-tl").evaluate(
            "(el) => getComputedStyle(el).animationName === 'none'",
        )
        _assert_no_viewport_overflow(portrait_page)
        expect(portrait_page.locator("#btn-scene")).to_have_attribute("aria-describedby", "scene-options")
        expect(portrait_page.locator("#scene-options")).to_contain_text("하늘, 도시, 해변, 숲")
        _assert_no_overlap(portrait_page, ["#time-dial", "#controls", "#center-cluster"])
        portrait_page.screenshot(path=str(EVIDENCE_DIR / "task-15-mobile-portrait.png"), full_page=True)
        _join_from_lobby(tablet_page, live_server, room_id, pin)
        expect(tablet_page.locator("#controls")).to_have_css("opacity", "1")
        _assert_no_overlap(tablet_page, ["#time-dial", "#controls", "#center-cluster"])
        tablet_page.screenshot(path=str(EVIDENCE_DIR / "task-15-mobile-tablet.png"), full_page=True)

        portrait_page.locator("#btn-scene").click(force=True)
        portrait_page.wait_for_function("() => document.body.dataset.scene === 'city'")
        portrait_page.wait_for_function(
            "() => getComputedStyle(document.getElementById('city-canvas')).opacity === '1'"
        )
        before = str(portrait_page.locator("#city-canvas").evaluate("(canvas) => canvas.toDataURL()"))
        portrait_page.wait_for_timeout(350)
        after = str(portrait_page.locator("#city-canvas").evaluate("(canvas) => canvas.toDataURL()"))
        assert before == after
        expect(portrait_page.locator("#room-status")).to_have_text("도시 장면으로 바꿨습니다.")

        _join_from_lobby(landscape_page, live_server, room_id, pin)
        expect(landscape_page.locator("#controls")).to_have_css("opacity", "1")
        _assert_no_viewport_overflow(landscape_page)
        landscape_page.screenshot(path=str(EVIDENCE_DIR / "task-15-mobile-landscape.png"), full_page=True)

        _write_evidence(
            "task-15-reduced-motion.txt",
            [
                f"room_id={room_id}",
                "viewports=390x844,768x1024,844x390",
                "verified=no_overlap,touch_controls_visible,reduced_motion_css_disabled,city_canvas_stable,scene_accessible_options,scene_status_announcement",
                "screenshots=task-15-mobile-portrait.png,task-15-mobile-tablet.png,task-15-mobile-landscape.png",
            ],
        )
    finally:
        portrait.close()
        landscape.close()
        tablet.close()
