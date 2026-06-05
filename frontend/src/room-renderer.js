import { byId } from "./dom.js";
import { createCelestialRenderer } from "./celestial-renderer.js";
import { createTimerView } from "./timer-view.js";


export function createRoomRenderer({ sceneController }) {
  const celestial = createCelestialRenderer({ sceneController });
  const timerView = createTimerView();

  function renderSessions(count) {
    const el = byId("sessions");
    if (!el || count === 0) {
      if (el) el.textContent = "";
      return;
    }
    const position = count % 4 || 4;
    el.textContent = "●".repeat(position) + "○".repeat(4 - position);
  }

  return {
    renderCelestial: celestial.renderCelestial,
    renderFocus: timerView.renderFocus,
    renderSatellite: celestial.renderSatellite,
    renderSessions,
    resetForResize: celestial.resetForResize,
  };
}


export function tickClock() {
  byId("clock").textContent = new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}


export function tickDate() {
  byId("date-label").textContent = new Date().toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}


export function startClock() {
  tickClock();
  tickDate();
  const msToNextMin = (60 - new Date().getSeconds()) * 1000;
  setTimeout(() => {
    tickClock();
    setInterval(tickClock, 60000);
  }, msToNextMin);
}


export function playChime() {
  try {
    const AudioContextCtor = window.AudioContext || window["webkit" + "AudioContext"];
    const ctx = new AudioContextCtor();
    [[528, 0], [396, 0.3], [528, 0.7]].forEach(([freq, when]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18, ctx.currentTime + when);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + when + 1.2);
      osc.start(ctx.currentTime + when);
      osc.stop(ctx.currentTime + when + 1.2);
    });
  } catch (_) {}
}
