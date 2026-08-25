import { byId, debounce } from "./dom.js";

export function fmtTime(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

function fmtSliderMinutes(value) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function createTimerControls({ getState, send }) {
  const timeSlider = byId("time-slider");
  const timeValue = byId("time-value");
  let sliderTouchedAt = 0;

  function updateSliderText(value) {
    const label = fmtSliderMinutes(Number(value));
    timeValue.textContent = label;
    timeSlider.setAttribute("aria-valuetext", label);
    // Day (06:00–17:59) shows the sun; the rest shows the moon
    const hours = Number(value) / 60;
    const isDay = hours >= 6 && hours < 18;
    byId("icon-sun").classList.toggle("hidden", !isDay);
    byId("icon-moon").classList.toggle("hidden", isDay);
  }

  function focusWhenShown(rowId, controlId, attempts = 40) {
    const row = byId(rowId);
    if (row.getAttribute("aria-hidden") === "false") {
      setTimeout(() => byId(controlId).focus(), 120);
      return;
    }
    if (attempts > 0) setTimeout(() => focusWhenShown(rowId, controlId, attempts - 1), 80);
  }

  function setDur(minutes) {
    send({ type: "set_duration", minutes });
  }

  function updateDurChips(activeMin) {
    document.querySelectorAll("#dur-chips button").forEach(btn => {
      const active = parseInt(btn.dataset.min, 10) === activeMin;
      btn.classList.toggle("active", active);
      btn.dataset.active = String(active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
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
    updateSliderText(timeSlider.value);
  }

  function resetTime() {
    sliderTouchedAt = Date.now();
    send({ type: "time_override", iso: null });
    const now = new Date();
    timeSlider.value = String(now.getHours() * 60 + now.getMinutes());
    updateSliderText(timeSlider.value);
  }

  document.querySelectorAll("#dur-chips button").forEach(btn => {
    btn.addEventListener("click", () => {
      const minutes = parseInt(btn.dataset.min, 10);
      const state = getState();
      const activeMin = state ? Math.round(state.pomodoro_duration / 60) : null;
      // Duration chips only choose a duration. Starting a shared session is a
      // deliberate action owned by the single primary "집중 시작" button.
      if (minutes !== activeMin) setDur(minutes);
    });
  });

  timeSlider.addEventListener("input", event => {
    sliderTouchedAt = Date.now();
    updateSliderText(event.target.value);
    sendOverride(Number(event.target.value));
  });
  timeSlider.addEventListener("dblclick", resetTime);
  byId("btn-reset-time").addEventListener("click", resetTime);
  byId("focus-btn").addEventListener("click", () => {
    send({ type: "focus_toggle" });
    focusWhenShown("focus-row", "btn-pause-timer");
  });
  byId("btn-pause-timer").addEventListener("click", () => send({ type: "focus_pause" }));
  byId("btn-cancel-timer").addEventListener("click", () => send({ type: "focus_cancel" }));
  byId("btn-skip-break").addEventListener("click", () => send({ type: "skip_break" }));
  byId("pomodoro").addEventListener("click", event => {
    if (event.target.closest("#btn-pause-timer, #btn-cancel-timer, #btn-skip-break")) return;
    if (!event.target.closest("#pom-time")) return;
    const state = getState();
    if (!state) return;
    if (state.focus) send({ type: "focus_pause" });
    else if (state.break) send({ type: "skip_break" });
  });
  updateSliderText(timeSlider.value);

  return { syncSlider, updateDurChips };
}
