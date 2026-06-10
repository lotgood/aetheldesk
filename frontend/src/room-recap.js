import { byId } from "./dom.js";


function focusMinutes(metrics) {
  return Math.floor(metrics.focus_seconds / 60);
}


export function createRoomRecapController() {
  const recap = byId("room-recap");

  function renderRecap(metrics) {
    recap.textContent = `이 방에서 ${metrics.sessions_completed}회 집중 · ${focusMinutes(metrics)}분 · 완료 ${metrics.tasks_completed}개`;
  }

  return { renderRecap };
}
