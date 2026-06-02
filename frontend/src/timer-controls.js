import { byId, debounce } from "./dom.js";

export function fmtTime(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

export function createTimerControls({ getState, send }) {
  const timeSlider = byId("time-slider");
  let sliderTouchedAt = 0;

  function setDur(minutes) {
    send({ type: "set_duration", minutes });
  }

  function updateDurChips(activeMin) {
    document.querySelectorAll("#dur-chips button").forEach(btn => {
      btn.classList.toggle("active", parseInt(btn.dataset.min, 10) === activeMin);
      btn.dataset.active = String(parseInt(btn.dataset.min, 10) === activeMin);
    });
  }

  const sendOverride = debounce(value => {
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const offsetMinutes = -now.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    send({ type: "time_override", iso: `${date}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00${offset}` });
  }, 80);

  function syncSlider(state) {
    if (Date.now() - sliderTouchedAt < 1500) return;
    if (state.time_override) {
      const match = state.time_override.match(/T(\d{2}):(\d{2})/);
      if (match) timeSlider.value = String(+match[1] * 60 + +match[2]);
    } else {
      const now = new Date();
      timeSlider.value = String(now.getHours() * 60 + now.getMinutes());
    }
  }

  function resetTime() {
    sliderTouchedAt = Date.now();
    send({ type: "time_override", iso: null });
    const now = new Date();
    timeSlider.value = String(now.getHours() * 60 + now.getMinutes());
  }

  document.querySelectorAll("#dur-chips button").forEach(btn => {
    btn.addEventListener("click", () => {
      const minutes = parseInt(btn.dataset.min, 10);
      const state = getState();
      const activeMin = state ? Math.round(state.pomodoro_duration / 60) : null;
      if (minutes === activeMin) send({ type: "focus_toggle" });
      else setDur(minutes);
    });
  });

  timeSlider.addEventListener("input", event => {
    sliderTouchedAt = Date.now();
    sendOverride(Number(event.target.value));
  });
  timeSlider.addEventListener("dblclick", resetTime);
  byId("btn-reset-time").addEventListener("click", resetTime);
  byId("focus-btn").addEventListener("click", () => send({ type: "focus_toggle" }));
  byId("btn-pause-timer").addEventListener("click", () => send({ type: "focus_pause" }));
  byId("btn-cancel-timer").addEventListener("click", () => send({ type: "focus_cancel" }));
  byId("btn-skip-break").addEventListener("click", () => send({ type: "skip_break" }));

  return { syncSlider, updateDurChips };
}
