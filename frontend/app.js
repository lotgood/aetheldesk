import { createSceneController } from "./scenes.js";
import { byId, createFocusTrap, setHiddenInteraction, setModalIsolation } from "./src/dom.js";
import { createDisplaySettings } from "./src/display-settings.js";
import { createRoomAuth } from "./src/room-auth.js";
import { createRoomRenderer, playChime, startClock, tickClock, tickDate } from "./src/room-renderer.js";
import { createRoomSocket } from "./src/room-websocket.js";
import { createRestRitual } from "./src/rest-ritual.js";
import { createScenePicker } from "./src/scene-picker.js";
import { migrateLegacyPlaylistStorage } from "./src/storage.js";
import { createTimerControls } from "./src/timer-controls.js";

const ROOM_ID = location.pathname.split("/").pop().toUpperCase();
byId("room-label").textContent = `# ${ROOM_ID}`;
byId("room-label").title = ROOM_ID;
byId("room-label").setAttribute("aria-label", `방 코드 ${ROOM_ID}`);
byId("btn-copy-room").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(ROOM_ID);
    byId("room-status").textContent = `방 코드 ${ROOM_ID}을 복사했습니다.`;
  } catch (_) {
    byId("room-status").textContent = `방 코드 ${ROOM_ID}을 선택해 복사해 주세요.`;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(byId("room-label"));
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

let currentState = null;
let acceptedRevision = null;
migrateLegacyPlaylistStorage();

const roomStatus = byId("room-status");
let roomStatusTimer = null;
new MutationObserver(() => {
  clearTimeout(roomStatusTimer);
  if (!roomStatus.textContent.trim()) return;
  roomStatusTimer = setTimeout(() => { roomStatus.textContent = ""; }, 3600);
}).observe(roomStatus, { childList: true, characterData: true, subtree: true });

const isTouch = navigator.maxTouchPoints > 1;
if (isTouch) document.body.classList.add("touch");

const roomStage = document.body;
const sceneController = createSceneController({ container: roomStage });
createDisplaySettings({ sceneController, statusEl: byId("room-status") });
createScenePicker({ sceneController, statusEl: byId("room-status") });
const renderer = createRoomRenderer({ sceneController, container: roomStage });
let socket;
const auth = createRoomAuth(ROOM_ID, () => socket.reconnectNow());
socket = createRoomSocket({
  roomId: ROOM_ID,
  connDot: byId("conn-dot"),
  connStatus: byId("conn-status"),
  connCopy: byId("conn-copy"),
  auth: {
    show(message) {
      socket?.clearReconnect();
      byId("conn-dot").style.opacity = "0";
      byId("conn-status").textContent = "방 PIN 확인이 필요합니다.";
      auth.show(message);
    },
    hide: auth.hide,
  },
  onState: applyState,
});

const timers = createTimerControls({ getState: () => currentState, send: msg => socket.send(msg) });
const restRitual = createRestRitual();
const exitTrap = createFocusTrap(byId("exit-confirm"), {
  initialFocus: byId("btn-exit-no"),
  onCancel: closeExitConfirm,
});

function applyState(state, { firstSnapshot = false } = {}) {
  if (firstSnapshot) acceptedRevision = null;
  const revision = Number.isInteger(state?.revision) && state.revision >= 0 ? state.revision : null;
  if (revision === null && acceptedRevision !== null) return;
  if (revision !== null && acceptedRevision !== null && revision < acceptedRevision) return;
  if (revision !== null) acceptedRevision = revision;

  const hadState = currentState !== null;
  const prevBreak = currentState?.break;
  currentState = state;

  renderer.renderCelestial(state.celestial);
  renderer.renderFocus(state.focus, state.pomodoro_remaining, state.break, state.break_remaining, state.paused);
  const restState = restRitual.update(state, { resetRewardBaseline: firstSnapshot });
  if (restState.reveal || (hadState && prevBreak && !state.break)) playChime();
  renderer.renderSatellite(state);
  sceneController.updatePomodoro(state);
  sceneController.updateReward({
    completedSessions: restState.cycleProgress,
    reveal: restState.reveal,
    active: restState.isBreak,
  });
  renderer.renderSessions(state.sessions_done);
  timers.updateDurChips(Math.round(state.pomodoro_duration / 60));
  timers.syncSlider(state);
  tickClock();
  tickDate();
}

window.addEventListener("resize", () => renderer.resetForResize(currentState));
startClock();

byId("btn-locate").addEventListener("click", () => {
  const status = byId("room-status");
  if (!navigator.geolocation) {
    status.textContent = "이 브라우저에서는 위치 권한을 사용할 수 없습니다.";
    return;
  }
  status.textContent = "현재 위치를 사용해 하늘 시간을 맞춥니다. 권한 요청을 확인해 주세요.";
  navigator.geolocation.getCurrentPosition(
    pos => {
      socket.send({ type: "location", lat: pos.coords.latitude, lon: pos.coords.longitude });
      status.textContent = "현재 위치를 반영해 방의 하늘을 맞췄습니다.";
    },
    () => { status.textContent = "위치 권한이 허용되지 않아 현재 위치를 반영하지 못했습니다."; }
  );
});

function openExitConfirm() {
  window.dispatchEvent(new CustomEvent("aethel:panel-open", { detail: { id: "exit-confirm" } }));
  byId("exit-confirm").style.display = "flex";
  setHiddenInteraction(byId("exit-confirm"), false);
  document.body.classList.add("panel-open");
  setModalIsolation(byId("exit-confirm"), true);
  byId("room-status").textContent = "진행 중인 집중을 끝내고 나갈지 확인해 주세요.";
  exitTrap.activate();
  byId("action-bar").style.display = "none";
}

function closeExitConfirm({ restoreFocus = true } = {}) {
  setModalIsolation(byId("exit-confirm"), false);
  exitTrap.deactivate({ restore: false });
  setHiddenInteraction(byId("exit-confirm"), true);
  byId("exit-confirm").style.display = "none";
  byId("action-bar").style.display = "";
  document.body.classList.remove("panel-open");
  byId("room-status").textContent = "나가기를 취소했습니다.";
  if (restoreFocus) setTimeout(() => byId("btn-exit").focus(), 120);
}

byId("btn-exit").addEventListener("click", () => {
  const active = currentState && (currentState.focus || currentState.break);
  if (active) {
    openExitConfirm();
  } else {
    location.href = "/";
  }
});
byId("btn-exit-yes").addEventListener("click", () => { location.href = "/"; });
byId("btn-exit-no").addEventListener("click", closeExitConfirm);
window.addEventListener("aethel:panel-open", event => {
  if (event.detail?.id !== "exit-confirm" && byId("exit-confirm").style.display !== "none") {
    closeExitConfirm({ restoreFocus: false });
  }
});

setHiddenInteraction(byId("exit-confirm"), true);
window.addEventListener("pagehide", () => sceneController.destroy(), { once: true });
socket.connect();
