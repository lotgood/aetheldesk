import { byId, setHiddenInteraction } from "./dom.js";
import { fmtTime } from "./timer-controls.js";

const SAT_RADIUS = 58;

// Renders the monumental timer as spans so the paused state can blink
// the colon like a stopped clock.
export function setPomTime(el, seconds, paused) {
  const min = String(Math.floor(seconds / 60)).padStart(2, "0");
  const sec = String(seconds % 60).padStart(2, "0");
  el.textContent = "";
  const minSpan = document.createElement("span");
  minSpan.textContent = min;
  const colon = document.createElement("span");
  colon.className = "t-colon" + (paused ? " paused" : "");
  colon.textContent = ":";
  const secSpan = document.createElement("span");
  secSpan.textContent = sec;
  el.append(minSpan, colon, secSpan);
}

function updateTimerTitle(focus, remaining, isBreak, breakRemaining, paused) {
  if (focus) {
    document.title = `${fmtTime(remaining)} ${paused ? "일시정지" : "집중"} - AethelDesk`;
  } else if (isBreak) {
    document.title = `${fmtTime(breakRemaining)} 휴식 - AethelDesk`;
  } else {
    document.title = "AethelDesk";
  }
}

export function createRoomRenderer({ sceneController, container = document.body }) {
  let celestialPos = null;
  let cloudState = null;
  let cloudRAF = null;
  let lastTimerAnnouncement = "";

  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  function getStageSize() {
    const rect = container.getBoundingClientRect();
    return {
      width: Math.max(1, rect.width || container.clientWidth || window.innerWidth),
      height: Math.max(1, rect.height || container.clientHeight || window.innerHeight),
    };
  }

  // With the 3D engine live, the legacy 2D star/cloud/satellite layers are
  // hidden (body.3d) and their rAF loops must not run. They remain the
  // fallback when WebGL is unavailable.
  function is3D() {
    return document.body.classList.contains("is-3d");
  }

  function renderCelestial(c) {
    document.body.style.setProperty("--sky-top", c.gradient[0]);
    document.body.style.setProperty("--sky-bot", c.gradient[1]);

    const { width, height } = getStageSize();
    const rx = width * 0.42;
    const ry = height * 0.55;
    const cx = width / 2;
    const cy = height * 0.88;

    byId("arc-path").setAttribute("d", `M ${cx - rx} ${cy} A ${rx} ${ry} 0 0 1 ${cx + rx} ${cy}`);

    const sunAngle = Math.PI - c.arc_pct * Math.PI;
    const sunX = cx + rx * Math.cos(sunAngle);
    const sunY = cy - ry * Math.sin(sunAngle);
    const rawMoonArcPct = Number(c.night_arc_pct);
    const moonArcPct = Number.isFinite(rawMoonArcPct) ? Math.max(0, Math.min(1, rawMoonArcPct)) : 0.5;
    const moonAngle = Math.PI - moonArcPct * Math.PI;
    const moonX = cx + rx * Math.cos(moonAngle);
    const moonY = cy - ry * Math.sin(moonAngle);

    const sg = byId("sun-group");
    const mg = byId("moon-group");
    sg.style.transform = `translate(${sunX}px,${sunY}px)`;
    mg.style.transform = `translate(${moonX}px,${moonY}px)`;

    celestialPos = c.phase === "day" ? { x: sunX, y: sunY } : { x: moonX, y: moonY };
    byId("sat-group").style.transform = `translate(${celestialPos.x}px,${celestialPos.y}px)`;

    const elev = c.elevation;
    const sunT = Math.max(0, Math.min(1, elev / 6));
    const sunOpacity = sunT * sunT * (3 - 2 * sunT);
    sg.style.opacity = String(sunOpacity);
    mg.style.opacity = String(Math.max(0, Math.min(1, (2 - elev) / 8)));

    document.body.classList.toggle("day", c.phase === "day");

    if (!is3D()) {
      const stars = byId("stars");
      stars.style.opacity = c.phase === "night" ? "0.45" : "0";
      if (c.phase === "night" && !stars.dataset.drawn) drawStars(stars);

      const cloudLight = Math.max(0, Math.min(1, (elev + 6) / 8));
      byId("clouds").style.opacity = String(cloudLight * 0.35);
      initClouds();
    }
    sceneController.render(c);
  }

  function drawStars(canvas) {
    canvas.dataset.drawn = "1";
    const { width, height } = getStageSize();
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    const ctx = canvas.getContext("2d");
    for (let i = 0; i < 180; i++) {
      ctx.beginPath();
      ctx.arc(Math.random() * canvas.width, Math.random() * canvas.height * 0.75,
              Math.random() * 1.2 + 0.3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.6 + 0.2})`;
      ctx.fill();
    }
  }

  function initClouds() {
    if (cloudState) return;
    const canvas = byId("clouds");
    const { width, height } = getStageSize();
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    cloudState = Array.from({ length: 5 }, (_, i) => ({
      x: Math.random() * canvas.width,
      y: canvas.height * (0.06 + i * 0.055 + Math.random() * 0.03),
      w: 110 + Math.random() * 90,
      h: 28 + Math.random() * 18,
      speed: 0.07 + Math.random() * 0.11,
    }));
    animateClouds();
  }

  function animateClouds() {
    const canvas = byId("clouds");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const cloud of cloudState) {
      if (!prefersReducedMotion()) cloud.x += cloud.speed;
      if (cloud.x - cloud.w > canvas.width) cloud.x = -cloud.w;
      drawCloud(ctx, cloud.x, cloud.y, cloud.w, cloud.h);
    }
    if (prefersReducedMotion()) return;
    cloudRAF = requestAnimationFrame(animateClouds);
  }

  function drawCloud(ctx, x, y, w, h) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.68)";
    ctx.beginPath(); ctx.ellipse(x, y, w * 0.50, h * 0.50, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x - w * 0.28, y + h * 0.10, w * 0.28, h * 0.38, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + w * 0.28, y + h * 0.10, w * 0.32, h * 0.42, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x, y - h * 0.30, w * 0.30, h * 0.40, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function resetForResize(currentState) {
    if (!currentState) return;
    if (!is3D()) {
      delete byId("stars").dataset.drawn;
      cloudState = null;
      if (cloudRAF) {
        cancelAnimationFrame(cloudRAF);
        cloudRAF = null;
      }
    }
    sceneController.resetForResize();
    renderCelestial(currentState.celestial);
  }

  function renderFocus(focus, remaining, isBreak, breakRemaining, paused) {
    const btn = byId("focus-btn");
    const durChips = byId("dur-chips");
    const pom = byId("pomodoro");
    const pomTime = byId("pom-time");
    const breakRow = byId("break-row");
    const focusRow = byId("focus-row");
    const pauseBtn = byId("btn-pause-timer");
    const skipBreakBtn = byId("btn-skip-break");
    const timerStatus = byId("timer-status");
    const idleDuration = byId("idle-duration");
    const pomPhase = byId("pom-phase");
    const activeEl = document.activeElement;
    updateTimerTitle(focus, remaining, isBreak, breakRemaining, paused);
    document.body.classList.toggle("is-session", Boolean(focus || isBreak));
    document.body.dataset.mode = focus ? (paused ? "paused" : "focus") : isBreak ? "break" : "idle";
    if (idleDuration) idleDuration.textContent = fmtTime(remaining);
    if (pomPhase) pomPhase.textContent = isBreak ? "휴식 중" : paused ? "집중 일시정지" : "집중 중";
    setHiddenInteraction(byId("time-dial"), Boolean(focus || isBreak));
    setHiddenInteraction(byId("hud-tl"), Boolean(focus || isBreak));

    function announce(key, message) {
      if (lastTimerAnnouncement === key) return;
      lastTimerAnnouncement = key;
      timerStatus.textContent = message;
    }

    if (focus) {
      const shouldMoveFocus = activeEl === btn || activeEl === document.body || activeEl === document.documentElement || durChips.contains(activeEl);
      btn.style.opacity = "0"; btn.style.pointerEvents = "none";
      durChips.style.opacity = "0"; durChips.style.pointerEvents = "none";
      pom.style.opacity = "1"; pom.style.pointerEvents = "auto";
      setHiddenInteraction(btn, true);
      setHiddenInteraction(durChips, true);
      setHiddenInteraction(pom, false);
      setPomTime(pomTime, remaining, paused);
      pomTime.style.opacity = "1";
      breakRow.style.opacity = "0"; breakRow.style.pointerEvents = "none";
      focusRow.style.opacity = "1"; focusRow.style.pointerEvents = "auto";
      setHiddenInteraction(breakRow, true);
      setHiddenInteraction(focusRow, false);
      pauseBtn.textContent = paused ? "재개" : "일시정지";
      const minuteBucket = Math.ceil(remaining / 60);
      announce(
        paused ? `focus-paused-${remaining}` : `focus-${minuteBucket}`,
        paused ? `집중 타이머가 일시정지되었습니다. 남은 시간 ${fmtTime(remaining)}.` : `집중 중입니다. 약 ${minuteBucket}분 남았습니다.`,
      );
      if (shouldMoveFocus) setTimeout(() => pauseBtn.focus(), 120);
    } else if (isBreak) {
      const shouldMoveFocus = activeEl === btn || activeEl === document.body || activeEl === document.documentElement || durChips.contains(activeEl) || focusRow.contains(activeEl);
      btn.style.opacity = "0"; btn.style.pointerEvents = "none";
      durChips.style.opacity = "0"; durChips.style.pointerEvents = "none";
      pom.style.opacity = "1"; pom.style.pointerEvents = "auto";
      setHiddenInteraction(btn, true);
      setHiddenInteraction(durChips, true);
      setHiddenInteraction(pom, false);
      setPomTime(pomTime, breakRemaining, false);
      pomTime.style.opacity = "1";
      breakRow.style.opacity = "1"; breakRow.style.pointerEvents = "auto";
      focusRow.style.opacity = "0"; focusRow.style.pointerEvents = "none";
      setHiddenInteraction(breakRow, false);
      setHiddenInteraction(focusRow, true);
      const minuteBucket = Math.ceil(breakRemaining / 60);
      announce(`break-${minuteBucket}`, `휴식 중입니다. 약 ${minuteBucket}분 남았습니다.`);
      if (shouldMoveFocus) {
        setTimeout(() => {
          const restTitle = byId("rest-title");
          const titleIsAvailable = restTitle && !restTitle.closest("[hidden], [inert]");
          (titleIsAvailable ? restTitle : skipBreakBtn).focus();
        }, 120);
      }
    } else {
      const shouldMoveFocus = pom.contains(activeEl);
      btn.style.opacity = "1"; btn.style.pointerEvents = "auto";
      durChips.style.opacity = "1"; durChips.style.pointerEvents = "auto";
      pom.style.opacity = "0"; pom.style.pointerEvents = "none";
      setHiddenInteraction(btn, false);
      setHiddenInteraction(durChips, false);
      setHiddenInteraction(pom, true);
      pomTime.style.opacity = "1";
      setPomTime(pomTime, remaining, false);
      breakRow.style.opacity = "0"; breakRow.style.pointerEvents = "none";
      focusRow.style.opacity = "0"; focusRow.style.pointerEvents = "none";
      setHiddenInteraction(breakRow, true);
      setHiddenInteraction(focusRow, true);
      announce("idle", "집중 타이머가 대기 중입니다.");
      if (shouldMoveFocus) setTimeout(() => btn.focus(), 120);
    }
  }

  function renderSatellite(state) {
    // Session progress line under the timer — drains focus and break alike
    const ring = byId("pom-progress");
    const active = state.focus
      ? { remain: state.pomodoro_remaining, total: state.pomodoro_duration }
      : state.break
        ? { remain: state.break_remaining, total: state.break_duration }
        : null;
    if (ring) {
      if (active && active.total > 0) {
        const fraction = Math.max(0, Math.min(1, active.remain / active.total));
        ring.style.width = (fraction * 100).toFixed(1) + "%";
        ring.style.opacity = "0.55";
      } else {
        ring.style.width = "100%";
        ring.style.opacity = "0";
      }
    }

    // The 3D astrolabe satellite renders the session orbit when body.3d is
    // active; the 2D satellite was only for the legacy sky layer.
    if (is3D()) return;
    const sat = byId("sat-group");
    const rot = byId("sat-rot");
    if (!state.focus || !celestialPos || state.pomodoro_duration <= 0) {
      sat.style.opacity = "0";
      return;
    }
    const progress = Math.max(0, Math.min(1, 1 - state.pomodoro_remaining / state.pomodoro_duration));
    const angle = progress * 2 * Math.PI;
    rot.style.transform = `translate(${SAT_RADIUS * Math.sin(angle)}px, ${-SAT_RADIUS * Math.cos(angle)}px)`;
    sat.style.opacity = "1";
  }

  function renderSessions(count) {
    const el = byId("sessions");
    if (!el) return;
    el.textContent = "";
    const position = count % 4 || (count > 0 ? 4 : 0);
    el.dataset.cycleProgress = String(position);
    el.setAttribute(
      "aria-label",
      count === 0 ? "완료한 집중 세션 없음" : `완료한 집중 세션 ${count}회, 현재 주기 ${position}/4`,
    );
    if (count === 0) {
      const empty = document.createElement("span");
      empty.className = "session-dot empty";
      empty.setAttribute("aria-hidden", "true");
      el.appendChild(empty);
      return;
    }
    for (let i = 0; i < 4; i++) {
      const dot = document.createElement("span");
      dot.className = "session-dot" + (i < position ? "" : " empty");
      dot.setAttribute("aria-hidden", "true");
      el.appendChild(dot);
    }
  }

  setHiddenInteraction(byId("pomodoro"), true);
  setHiddenInteraction(byId("break-row"), true);
  setHiddenInteraction(byId("focus-row"), true);

  return { renderCelestial, renderFocus, renderSatellite, renderSessions, resetForResize };
}

export function tickClock() {
  byId("clock").textContent = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function tickDate() {
  byId("date-label").textContent = new Date().toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
}

export function startClock() {
  tickClock();
  tickDate();
  const msToNextMin = (60 - new Date().getSeconds()) * 1000;
  setTimeout(() => { tickClock(); setInterval(tickClock, 60000); }, msToNextMin);
}

export function playChime() {
  let ctx;
  try {
    const AudioContextCtor = window.AudioContext || window["webkit" + "AudioContext"];
    if (!AudioContextCtor) return;
    ctx = new AudioContextCtor();
    const notes = [[528, 0], [396, 0.3], [528, 0.7]];
    let remaining = notes.length;
    notes.forEach(([freq, when]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18, ctx.currentTime + when);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + when + 1.2);
      osc.addEventListener("ended", () => {
        remaining -= 1;
        if (remaining === 0) void ctx.close();
      }, { once: true });
      osc.start(ctx.currentTime + when);
      osc.stop(ctx.currentTime + when + 1.2);
    });
  } catch (_) {
    void ctx?.close?.();
  }
}
