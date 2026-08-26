from __future__ import annotations

from pathlib import Path
import re

import pytest
from playwright.sync_api import Browser, ViewportSize, expect


VIEWPORT_MATRIX = (
    # Real Chrome content area on a 1920-wide display after browser chrome is
    # deducted. It is intentionally much wider than 16:9 and reproduces the
    # user's normal, non-fullscreen room rather than an idealized video frame.
    ({"width": 1920, "height": 907}, 1),
    ({"width": 1920, "height": 993}, 1),
    ({"width": 1600, "height": 900}, 1),
    ({"width": 1600, "height": 1200}, 1),
    ({"width": 1366, "height": 625}, 1),
    ({"width": 1280, "height": 720}, 1),
    ({"width": 1280, "height": 650}, 1.25),
    ({"width": 1024, "height": 576}, 1.25),
    ({"width": 853, "height": 480}, 1.5),
    ({"width": 640, "height": 360}, 2),
    ({"width": 1024, "height": 768}, 2),
    ({"width": 901, "height": 768}, 1),
    ({"width": 901, "height": 508}, 1),
    ({"width": 390, "height": 844}, 3),
    ({"width": 844, "height": 390}, 2),
    ({"width": 568, "height": 320}, 2),
    ({"width": 320, "height": 480}, 2),
    ({"width": 320, "height": 568}, 2),
)


EVIDENCE_DIR = Path(__file__).resolve().parents[2] / ".omo" / "evidence"


@pytest.mark.e2e
@pytest.mark.parametrize(("viewport", "device_scale_factor"), VIEWPORT_MATRIX)
def test_focus_control_remains_a_circle_at_every_supported_scale(
    browser: Browser,
    live_server: str,
    viewport: ViewportSize,
    device_scale_factor: float,
) -> None:
    context = browser.new_context(viewport=viewport, device_scale_factor=device_scale_factor)
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    expect(page.locator("#focus-btn")).to_be_visible()
    page.locator("#aethel-3d-canvas").wait_for(state="attached")

    geometry = page.locator("#focus-btn").evaluate(
        "element => {"
        "  const rect = element.getBoundingClientRect();"
        "  const style = getComputedStyle(element);"
        "  return { width: rect.width, height: rect.height, aspect: style.aspectRatio, boxSizing: style.boxSizing };"
        "}"
    )

    assert geometry["aspect"] == "1 / 1"
    assert geometry["boxSizing"] == "border-box"
    assert abs(geometry["width"] - geometry["height"]) <= 0.5

    layout = page.evaluate(
        "() => {"
        "  const stage = document.body.getBoundingClientRect();"
        "  const canvas = document.getElementById('aethel-3d-canvas').getBoundingClientRect();"
        "  return {"
        "    stage: { left: stage.left, top: stage.top, width: stage.width, height: stage.height },"
        "    canvas: { left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height },"
        "    scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }"
        "  };"
        "}"
    )
    assert abs(layout["stage"]["left"]) <= 0.5
    assert abs(layout["stage"]["top"]) <= 0.5
    assert abs(layout["stage"]["width"] - viewport["width"]) <= 0.5
    assert abs(layout["stage"]["height"] - viewport["height"]) <= 0.5
    assert abs(layout["scroll"]["width"] - viewport["width"]) <= 0.5
    assert abs(layout["scroll"]["height"] - viewport["height"]) <= 0.5

    for axis in ("left", "top", "width", "height"):
        assert abs(layout["canvas"][axis] - layout["stage"][axis]) <= 0.5

    page.locator("#focus-btn").hover()
    hovered = page.locator("#focus-btn").bounding_box()
    assert hovered is not None
    assert abs(hovered["width"] - hovered["height"]) <= 0.5
    context.close()


@pytest.mark.e2e
def test_coarse_pointer_tablet_keeps_the_responsive_full_viewport(browser: Browser, live_server: str) -> None:
    viewport: ViewportSize = {"width": 1024, "height": 768}
    context = browser.new_context(viewport=viewport, has_touch=True, is_mobile=True)
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))

    layout = page.evaluate(
        "() => {"
        "  const rect = document.body.getBoundingClientRect();"
        "  return { width: rect.width, height: rect.height, coarse: matchMedia('(pointer: coarse)').matches };"
        "}"
    )
    assert layout["coarse"] is True
    assert abs(layout["width"] - viewport["width"]) <= 0.5
    assert abs(layout["height"] - viewport["height"]) <= 0.5
    context.close()


@pytest.mark.e2e
def test_no_webgl_fallback_uses_the_same_full_viewport_geometry(browser: Browser, live_server: str) -> None:
    viewport: ViewportSize = {"width": 1280, "height": 650}
    context = browser.new_context(viewport=viewport)
    page = context.new_page()
    page.add_init_script(
        """
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
          if (String(type).startsWith('webgl')) return null;
          return originalGetContext.call(this, type, ...args);
        };
        """
    )
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    expect(page.locator("#conn-copy")).to_have_text("연결됨")
    page.wait_for_function("() => !document.body.classList.contains('is-3d')")
    page.evaluate(
        "() => {"
        "  const slider = document.getElementById('time-slider');"
        "  slider.value = '0';"
        "  slider.dispatchEvent(new Event('input', { bubbles: true }));"
        "}"
    )
    page.wait_for_function("() => document.getElementById('stars').dataset.drawn === '1'")

    fallback = page.evaluate(
        "() => {"
        "  const stage = document.body.getBoundingClientRect();"
        "  const stars = document.getElementById('stars');"
        "  const clouds = document.getElementById('clouds');"
        "  const sky = document.getElementById('sky').getBoundingClientRect();"
        "  const starsRect = stars.getBoundingClientRect();"
        "  return {"
        "    stage: { left: stage.left, top: stage.top, width: stage.width, height: stage.height },"
        "    stars: { width: stars.width, height: stars.height, cssWidth: starsRect.width, cssHeight: starsRect.height },"
        "    clouds: { width: clouds.width, height: clouds.height },"
        "    sky: { left: sky.left, top: sky.top, width: sky.width, height: sky.height }"
        "  };"
        "}"
    )
    assert abs(fallback["stage"]["left"]) <= 0.5
    assert abs(fallback["stage"]["top"]) <= 0.5
    assert abs(fallback["stage"]["width"] - viewport["width"]) <= 0.5
    assert abs(fallback["stage"]["height"] - viewport["height"]) <= 0.5
    assert fallback["stars"]["width"] == round(fallback["stage"]["width"])
    assert fallback["stars"]["height"] == round(fallback["stage"]["height"])
    assert fallback["clouds"]["width"] == round(fallback["stage"]["width"])
    assert fallback["clouds"]["height"] == round(fallback["stage"]["height"])
    assert abs(fallback["stars"]["cssWidth"] - fallback["stage"]["width"]) <= 0.5
    assert abs(fallback["stars"]["cssHeight"] - fallback["stage"]["height"]) <= 0.5
    for axis in ("left", "top", "width", "height"):
        assert abs(fallback["sky"][axis] - fallback["stage"][axis]) <= 0.5
    context.close()


@pytest.mark.e2e
def test_four_three_desktop_keeps_time_dial_out_of_celestial_lane(browser: Browser, live_server: str) -> None:
    context = browser.new_context(viewport={"width": 1024, "height": 768}, reduced_motion="reduce")
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    expect(page.locator("#conn-copy")).to_have_text("연결됨")

    geometry = page.evaluate(
        "() => {"
        "  const box = selector => {"
        "    const rect = document.querySelector(selector).getBoundingClientRect();"
        "    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };"
        "  };"
        "  return { stage: box('body'), dial: box('#time-dial'), action: box('#action-bar') };"
        "}"
    )

    stage = geometry["stage"]
    dial = geometry["dial"]
    assert dial["right"] < stage["left"] + stage["width"] * 0.3
    assert dial["bottom"] > stage["top"] + stage["height"] * 0.75
    action = geometry["action"]
    horizontal_overlap = max(0, min(dial["right"], action["right"]) - max(dial["left"], action["left"]))
    vertical_overlap = max(0, min(dial["bottom"], action["bottom"]) - max(dial["top"], action["top"]))
    assert horizontal_overlap * vertical_overlap == 0
    context.close()


@pytest.mark.e2e
@pytest.mark.parametrize(
    "viewport",
    (
        {"width": 1920, "height": 993},
        {"width": 1366, "height": 625},
        {"width": 901, "height": 768},
        {"width": 901, "height": 508},
    ),
)
def test_fullscreen_desktop_hud_lanes_do_not_overlap(
    browser: Browser,
    live_server: str,
    viewport: ViewportSize,
) -> None:
    context = browser.new_context(viewport=viewport, reduced_motion="reduce")
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    expect(page.locator("#conn-copy")).to_have_text("연결됨")

    metrics = page.evaluate(
        "() => {"
        "  const rect = selector => document.querySelector(selector).getBoundingClientRect();"
        "  const overlap = (a, b) => {"
        "    const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));"
        "    const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));"
        "    return x * y;"
        "  };"
        "  const center = rect('#center-cluster');"
        "  const focus = rect('#focus-btn');"
        "  const dial = rect('#time-dial');"
        "  const action = rect('#action-bar');"
        "  const body = rect('body');"
        "  return {"
        "    centerAction: overlap(center, action),"
        "    dialCenter: overlap(dial, center),"
        "    dialFocus: overlap(dial, focus),"
        "    dialAction: overlap(dial, action),"
        "    bounds: [body.left, body.top, body.right, body.bottom],"
        "    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight]"
        "  };"
        "}"
    )

    assert metrics["centerAction"] == 0
    assert metrics["dialCenter"] == 0
    assert metrics["dialFocus"] == 0
    assert metrics["dialAction"] == 0
    assert metrics["bounds"] == pytest.approx([0, 0, viewport["width"], viewport["height"]], abs=0.5)
    assert metrics["scroll"] == pytest.approx([viewport["width"], viewport["height"]], abs=0.5)
    context.close()


@pytest.mark.e2e
def test_mobile_address_bar_resize_keeps_full_viewport_and_circle(browser: Browser, live_server: str) -> None:
    context = browser.new_context(
        viewport={"width": 390, "height": 844},
        has_touch=True,
        is_mobile=True,
        reduced_motion="reduce",
    )
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    page.set_viewport_size({"width": 390, "height": 600})
    page.wait_for_function(
        "() => {"
        "  const body = document.body.getBoundingClientRect();"
        "  const canvas = document.getElementById('aethel-3d-canvas')?.getBoundingClientRect();"
        "  return body.width === 390 && body.height === 600 && canvas?.width === 390 && canvas?.height === 600;"
        "}"
    )

    metrics = page.evaluate(
        "() => {"
        "  const body = document.body.getBoundingClientRect();"
        "  const focus = document.getElementById('focus-btn').getBoundingClientRect();"
        "  const controls = document.getElementById('controls').getBoundingClientRect();"
        "  return {"
        "    body: [body.left, body.top, body.width, body.height],"
        "    focus: [focus.width, focus.height],"
        "    controlsBottom: controls.bottom,"
        "    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight]"
        "  };"
        "}"
    )

    assert metrics["body"] == pytest.approx([0, 0, 390, 600], abs=0.5)
    assert abs(metrics["focus"][0] - metrics["focus"][1]) <= 0.5
    assert metrics["controlsBottom"] <= 600.5
    assert metrics["scroll"] == pytest.approx([390, 600], abs=0.5)
    context.close()


@pytest.mark.e2e
def test_short_landscape_lobby_footer_does_not_overlap_primary_cta(browser: Browser, live_server: str) -> None:
    viewport: ViewportSize = {"width": 844, "height": 390}
    context = browser.new_context(viewport=viewport, has_touch=True, is_mobile=True, reduced_motion="reduce")
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")

    metrics = page.evaluate(
        "() => {"
        "  const footer = document.querySelector('.lobby-footer').getBoundingClientRect();"
        "  const cta = document.getElementById('btn-start').getBoundingClientRect();"
        "  const tagline = document.querySelector('.lobby-tagline').innerText;"
        "  const x = Math.max(0, Math.min(footer.right, cta.right) - Math.max(footer.left, cta.left));"
        "  const y = Math.max(0, Math.min(footer.bottom, cta.bottom) - Math.max(footer.top, cta.top));"
        "  return { overlap: x * y, footer: footer.toJSON(), cta: cta.toJSON(), tagline };"
        "}"
    )

    assert metrics["overlap"] == 0
    assert "아래, 각자의" in metrics["tagline"].replace("\n", " ")
    context.close()


@pytest.mark.e2e
@pytest.mark.parametrize("viewport", ({"width": 844, "height": 390}, {"width": 640, "height": 360}))
def test_short_landscape_tools_keep_one_clear_bottom_lane(
    browser: Browser,
    live_server: str,
    viewport: ViewportSize,
) -> None:
    context = browser.new_context(viewport=viewport, has_touch=True, is_mobile=True, reduced_motion="reduce")
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    expect(page.locator("#conn-copy")).to_have_text("연결됨")
    metrics = page.evaluate(
        "() => {"
        "  const rect = selector => document.querySelector(selector).getBoundingClientRect();"
        "  const overlap = (a, b) => {"
        "    const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));"
        "    const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));"
        "    return x * y;"
        "  };"
        "  const action = rect('#action-bar');"
        "  const dial = rect('#time-dial');"
        "  const focus = rect('#focus-btn');"
        "  return {"
        "    dialControls: overlap(dial, rect('#controls')) ,"
        "    dialFocus: overlap(dial, focus),"
        "    focusTop: focus.top,"
        "    actionLeft: action.left,"
        "    actionRight: action.right"
        "  };"
        "}"
    )

    assert metrics["dialControls"] == 0
    assert metrics["dialFocus"] == 0
    assert metrics["focusTop"] >= 54
    assert metrics["actionLeft"] >= -0.5
    assert metrics["actionRight"] <= viewport["width"] + 0.5
    context.close()


@pytest.mark.e2e
@pytest.mark.parametrize(
    "viewport",
    (
        {"width": 568, "height": 320},
        {"width": 320, "height": 480},
    ),
)
def test_ultra_compact_idle_hud_lanes_do_not_overlap(
    browser: Browser,
    live_server: str,
    viewport: ViewportSize,
) -> None:
    context = browser.new_context(viewport=viewport, has_touch=True, is_mobile=True, reduced_motion="reduce")
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    expect(page.locator("#conn-copy")).to_have_text("연결됨")

    metrics = page.evaluate(
        """
        () => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect();
          const overlap = (a, b) => {
            const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            return x * y;
          };
          const body = rect('body');
          const center = rect('#center-cluster');
          const focus = rect('#focus-btn');
          const chips = rect('#dur-chips');
          const dial = rect('#time-dial');
          const controls = rect('#controls');
          const action = rect('#action-bar');
          const inBounds = value => value.left >= -0.5 && value.top >= -0.5
            && value.right <= innerWidth + 0.5 && value.bottom <= innerHeight + 0.5;
          return {
            dialCenter: overlap(dial, center),
            dialFocus: overlap(dial, focus),
            controlsChips: overlap(controls, chips),
            actionChips: overlap(action, chips),
            circle: [focus.width, focus.height],
            bounds: [inBounds(center), inBounds(focus), inBounds(chips), inBounds(dial), inBounds(action)],
            stage: [body.left, body.top, body.width, body.height],
            scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
          };
        }
        """
    )

    assert metrics["dialCenter"] == 0
    assert metrics["dialFocus"] == 0
    assert metrics["controlsChips"] == 0
    assert metrics["actionChips"] == 0
    assert abs(metrics["circle"][0] - metrics["circle"][1]) <= 0.5
    assert metrics["bounds"] == [True, True, True, True, True]
    assert metrics["stage"] == pytest.approx([0, 0, viewport["width"], viewport["height"]], abs=0.5)
    assert metrics["scroll"] == pytest.approx([viewport["width"], viewport["height"]], abs=0.5)

    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    screenshot = page.screenshot(
        path=str(EVIDENCE_DIR / f"responsive-idle-{viewport['width']}x{viewport['height']}.png"),
        full_page=False,
    )
    assert screenshot.startswith(b"\x89PNG\r\n\x1a\n")
    context.close()


@pytest.mark.e2e
@pytest.mark.parametrize(
    "viewport",
    (
        {"width": 320, "height": 480},
        {"width": 568, "height": 320},
        {"width": 640, "height": 360},
    ),
)
def test_short_break_ritual_and_dock_keep_separate_lanes(
    browser: Browser,
    live_server: str,
    viewport: ViewportSize,
) -> None:
    context = browser.new_context(viewport=viewport, has_touch=True, is_mobile=True, reduced_motion="reduce")
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    expect(page.locator("#conn-copy")).to_have_text("연결됨")

    page.evaluate(
        """
        () => {
          document.body.classList.add('is-session');
          document.body.dataset.mode = 'break';
          document.body.dataset.restPhase = 'restore';
          const show = id => {
            const el = document.getElementById(id);
            el.hidden = false;
            el.removeAttribute('inert');
            el.setAttribute('aria-hidden', 'false');
            el.style.opacity = '1';
            el.style.pointerEvents = 'auto';
          };
          show('pomodoro');
          show('rest-ritual');
          show('rest-recovery-options');
          show('break-row');
          document.getElementById('focus-row').style.opacity = '0';
        }
        """
    )

    metrics = page.evaluate(
        """
        () => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect();
          const overlap = (a, b) => {
            const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            return x * y;
          };
          const viewportRect = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
          const ritual = rect('#rest-ritual');
          const breakRow = rect('#break-row');
          const action = rect('#action-bar');
          const timer = rect('#pom-time');
          const inBounds = value => value.left >= -0.5 && value.top >= -0.5
            && value.right <= innerWidth + 0.5 && value.bottom <= innerHeight + 0.5;
          return {
            ritualDock: overlap(ritual, action),
            breakDock: overlap(breakRow, action),
            timerRitual: overlap(timer, ritual),
            bounds: [inBounds(ritual), inBounds(breakRow), inBounds(action), inBounds(timer)],
            scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
            viewport: viewportRect,
          };
        }
        """
    )

    assert metrics["ritualDock"] == 0
    assert metrics["breakDock"] == 0
    assert metrics["timerRitual"] == 0
    assert metrics["bounds"] == [True, True, True, True]
    assert metrics["scroll"] == pytest.approx([viewport["width"], viewport["height"]], abs=0.5)
    context.close()


@pytest.mark.e2e
@pytest.mark.parametrize("viewport", ({"width": 390, "height": 700}, {"width": 844, "height": 390}))
def test_mobile_room_visible_touch_targets_are_at_least_44px(
    browser: Browser,
    live_server: str,
    viewport: ViewportSize,
) -> None:
    context = browser.new_context(viewport=viewport, has_touch=True, is_mobile=True, reduced_motion="reduce")
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    expect(page.locator("#conn-copy")).to_have_text("연결됨")

    small_targets = page.evaluate(
        "() => [...document.querySelectorAll('button,input,select')]"
        "  .map(el => {"
        "    const rect = el.getBoundingClientRect();"
        "    const style = getComputedStyle(el);"
        "    return {"
        "      id: el.id || el.className,"
        "      text: (el.innerText || el.getAttribute('aria-label') || el.placeholder || '').trim(),"
        "      width: rect.width,"
        "      height: rect.height,"
        "      visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01 && rect.width > 0 && rect.height > 0,"
        "      inert: el.closest('[inert]') !== null"
        "    };"
        "  })"
        "  .filter(item => item.visible && !item.inert && (item.width < 44 || item.height < 44))"
    )

    assert small_targets == []
    context.close()


@pytest.mark.e2e
@pytest.mark.parametrize(
    ("viewport", "has_touch", "is_mobile"),
    (
        ({"width": 390, "height": 700}, True, True),
        ({"width": 1024, "height": 768}, True, True),
        ({"width": 1280, "height": 720}, False, False),
    ),
)
def test_status_toast_stays_in_non_control_lane(
    browser: Browser,
    live_server: str,
    viewport: ViewportSize,
    has_touch: bool,
    is_mobile: bool,
) -> None:
    context = browser.new_context(
        viewport=viewport,
        reduced_motion="reduce",
        has_touch=has_touch,
        is_mobile=is_mobile,
    )
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    expect(page.locator("#conn-copy")).to_have_text("연결됨")
    page.locator("#btn-scene").click()
    page.locator('.scene-option[data-scene="city"]').click()
    page.wait_for_function("() => document.getElementById('room-status').innerText.includes('도시')")

    metrics = page.evaluate(
        "() => {"
        "  const rect = selector => document.querySelector(selector).getBoundingClientRect();"
        "  const overlap = (a, b) => {"
        "    const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));"
        "    const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));"
        "    return x * y;"
        "  };"
        "  const toast = rect('#room-status');"
        "  const dial = rect('#time-dial');"
        "  const action = rect('#action-bar');"
        '  const interactiveOverlap = [...document.querySelectorAll(\'button,input,select,a,[role="button"],[tabindex]:not([tabindex="-1"])\')]'
        "    .map(el => {"
        "      const itemRect = el.getBoundingClientRect();"
        "      const style = getComputedStyle(el);"
        "      return {"
        "        id: el.id || el.dataset.scene || el.className,"
        "        area: overlap(toast, itemRect),"
        "        visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01 && itemRect.width > 0 && itemRect.height > 0,"
        "        inert: el.closest('[inert]') !== null"
        "      };"
        "    })"
        "    .filter(item => item.visible && !item.inert && item.area > 0.5);"
        "  return {"
        "    toastTop: toast.top,"
        "    toastRight: toast.right,"
        "    toastText: document.getElementById('room-status').innerText,"
        "    dialActionOverlap: overlap(dial, action),"
        "    interactiveOverlap"
        "  };"
        "}"
    )

    assert "도시" in metrics["toastText"]
    assert 0 < metrics["toastTop"] < viewport["height"]
    assert metrics["toastRight"] <= viewport["width"] + 0.5
    assert metrics["interactiveOverlap"] == []
    assert metrics["dialActionOverlap"] == 0
    context.close()


@pytest.mark.e2e
def test_room_modal_isolation_restores_focus_to_triggers(browser: Browser, live_server: str) -> None:
    viewport: ViewportSize = {"width": 390, "height": 700}
    context = browser.new_context(viewport=viewport, has_touch=True, is_mobile=True, reduced_motion="reduce")
    page = context.new_page()
    page.goto(f"{live_server}/", wait_until="domcontentloaded")
    page.locator("#pin-input").fill("2468")
    page.locator("#btn-start").click()
    expect(page).to_have_url(re.compile(rf"{re.escape(live_server)}/room/[A-Z0-9]+"))
    expect(page.locator("#conn-copy")).to_have_text("연결됨")

    page.locator("#btn-display").click()
    expect(page.locator("#display-panel")).to_be_visible()
    page.locator("#display-panel-close").click()
    page.wait_for_function("() => document.activeElement?.id === 'btn-display'")

    page.locator("#btn-scene").click()
    expect(page.locator("#scene-panel")).to_be_visible()
    page.locator("#scene-panel-close").click()
    page.wait_for_function("() => document.activeElement?.id === 'btn-scene'")

    page.locator("#focus-btn").click()
    page.wait_for_function("() => document.body.classList.contains('is-session')")
    page.locator("#btn-exit").click()
    expect(page.locator("#exit-confirm")).to_be_visible()
    isolated = page.evaluate(
        "() => document.getElementById('center-cluster').closest('[aria-hidden=\"true\"],[inert]') !== null"
    )
    assert isolated is True
    page.locator("#btn-exit-no").click()
    page.wait_for_function("() => document.activeElement?.id === 'btn-exit'")
    restored = page.evaluate(
        "() => ({"
        "  active: document.activeElement?.id,"
        "  centerHidden: document.getElementById('center-cluster').closest('[aria-hidden=\"true\"],[inert]') !== null,"
        "  exitHidden: document.getElementById('exit-confirm').matches('[aria-hidden=\"true\"][inert]')"
        "})"
    )
    assert restored == {"active": "btn-exit", "centerHidden": False, "exitHidden": True}
    context.close()
