import { byId, setHiddenInteraction } from "./dom.js";


export function fmtTime(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}


export function updateTimerTitle(focus, remaining, isBreak, breakRemaining, paused) {
  if (focus) {
    document.title = `${fmtTime(remaining)} ${paused ? "일시정지" : "집중"} - AethelDesk`;
  } else if (isBreak) {
    document.title = `${fmtTime(breakRemaining)} 휴식 - AethelDesk`;
  } else {
    document.title = "AethelDesk";
  }
}


export function createTimerView() {
  const btn = byId("focus-btn");
  const durChips = byId("dur-chips");
  const pom = byId("pomodoro");
  const pomTime = byId("pom-time");
  const breakRow = byId("break-row");
  const focusRow = byId("focus-row");
  const pauseBtn = byId("btn-pause-timer");
  const skipBreakBtn = byId("btn-skip-break");
  const timerStatus = byId("timer-status");

  function renderFocus(focus, remaining, isBreak, breakRemaining, paused) {
    const activeEl = document.activeElement;
    updateTimerTitle(focus, remaining, isBreak, breakRemaining, paused);
    if (focus) {
      renderFocusRunning({ activeEl, remaining, paused });
    } else if (isBreak) {
      renderBreakRunning({ activeEl, breakRemaining });
    } else {
      renderTimerIdle(activeEl);
    }
  }

  function renderFocusRunning({ activeEl, remaining, paused }) {
    const shouldMoveFocus = activeEl === btn || activeEl === document.body || activeEl === document.documentElement || durChips.contains(activeEl);
    btn.style.opacity = "0"; btn.style.pointerEvents = "none";
    durChips.style.opacity = "0"; durChips.style.pointerEvents = "none";
    pom.style.opacity = "1"; pom.style.pointerEvents = "auto";
    setHiddenInteraction(btn, true);
    setHiddenInteraction(durChips, true);
    setHiddenInteraction(pom, false);
    pomTime.textContent = fmtTime(remaining);
    pomTime.style.opacity = paused ? "0.45" : "1";
    breakRow.style.opacity = "0"; breakRow.style.pointerEvents = "none";
    focusRow.style.opacity = "1"; focusRow.style.pointerEvents = "auto";
    setHiddenInteraction(breakRow, true);
    setHiddenInteraction(focusRow, false);
    pauseBtn.textContent = paused ? "재개" : "일시정지";
    timerStatus.textContent = paused ? "집중 타이머가 일시정지되었습니다." : `집중 중입니다. 남은 시간 ${fmtTime(remaining)}.`;
    if (shouldMoveFocus) setTimeout(() => pauseBtn.focus(), 120);
  }

  function renderBreakRunning({ activeEl, breakRemaining }) {
    const shouldMoveFocus = activeEl === btn || activeEl === document.body || activeEl === document.documentElement || durChips.contains(activeEl) || focusRow.contains(activeEl);
    btn.style.opacity = "0"; btn.style.pointerEvents = "none";
    durChips.style.opacity = "0"; durChips.style.pointerEvents = "none";
    pom.style.opacity = "1"; pom.style.pointerEvents = "auto";
    setHiddenInteraction(btn, true);
    setHiddenInteraction(durChips, true);
    setHiddenInteraction(pom, false);
    pomTime.textContent = fmtTime(breakRemaining);
    pomTime.style.opacity = "1";
    breakRow.style.opacity = "1"; breakRow.style.pointerEvents = "auto";
    focusRow.style.opacity = "0"; focusRow.style.pointerEvents = "none";
    setHiddenInteraction(breakRow, false);
    setHiddenInteraction(focusRow, true);
    timerStatus.textContent = `휴식 중입니다. 남은 시간 ${fmtTime(breakRemaining)}.`;
    if (shouldMoveFocus) setTimeout(() => skipBreakBtn.focus(), 120);
  }

  function renderTimerIdle(activeEl) {
    const shouldMoveFocus = pom.contains(activeEl);
    btn.style.opacity = "1"; btn.style.pointerEvents = "auto";
    durChips.style.opacity = "1"; durChips.style.pointerEvents = "auto";
    pom.style.opacity = "0"; pom.style.pointerEvents = "none";
    setHiddenInteraction(btn, false);
    setHiddenInteraction(durChips, false);
    setHiddenInteraction(pom, true);
    pomTime.style.opacity = "1";
    breakRow.style.opacity = "0"; breakRow.style.pointerEvents = "none";
    focusRow.style.opacity = "0"; focusRow.style.pointerEvents = "none";
    setHiddenInteraction(breakRow, true);
    setHiddenInteraction(focusRow, true);
    timerStatus.textContent = "집중 타이머가 대기 중입니다.";
    if (shouldMoveFocus) setTimeout(() => btn.focus(), 120);
  }

  setHiddenInteraction(pom, true);
  setHiddenInteraction(breakRow, true);
  setHiddenInteraction(focusRow, true);

  return { renderFocus };
}
