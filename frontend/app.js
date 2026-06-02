import { createSceneController } from "./scenes.js";
import { byId, createFocusTrap, setHiddenInteraction } from "./src/dom.js";
import { createMusicController } from "./src/music-youtube.js";
import { createRoomAuth } from "./src/room-auth.js";
import { createRoomRenderer, playChime, startClock, tickClock, tickDate } from "./src/room-renderer.js";
import { createRoomSocket } from "./src/room-websocket.js";
import { createPlaylistState } from "./src/storage.js";
import { createTimerControls } from "./src/timer-controls.js";

const ROOM_ID = location.pathname.split("/").pop().toUpperCase();
byId("room-label").textContent = `# ${ROOM_ID}`;

const playlist = createPlaylistState();
let currentState = null;

const isTouch = navigator.maxTouchPoints > 1;
if (isTouch) document.body.classList.add("touch");

const sceneController = createSceneController();
const renderer = createRoomRenderer({ sceneController });
let socket;
const auth = createRoomAuth(ROOM_ID, () => socket.reconnectNow());
socket = createRoomSocket({
  roomId: ROOM_ID,
  connDot: byId("conn-dot"),
  connStatus: byId("conn-status"),
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
const music = createMusicController({ playlist, getState: () => currentState, send: msg => socket.send(msg) });
const exitTrap = createFocusTrap(byId("exit-confirm"), {
  initialFocus: byId("btn-exit-no"),
  onCancel: closeExitConfirm,
});

function applyState(state) {
  const prevBreak = currentState?.break;
  currentState = state;

  if (!prevBreak && state.break) playChime();
  if (prevBreak && !state.break) playChime();

  const playlistIndex = playlist.ids.indexOf(state.music.video_id);
  if (playlistIndex !== -1) playlist.index = playlistIndex;

  renderer.renderCelestial(state.celestial);
  renderer.renderFocus(state.focus, state.pomodoro_remaining, state.break, state.break_remaining, state.paused);
  renderer.renderSatellite(state);
  renderer.renderSessions(state.sessions_done);
  timers.updateDurChips(Math.round(state.pomodoro_duration / 60));
  music.syncYT(state.music);
  timers.syncSlider(state);
  tickClock();
  tickDate();
}

window.addEventListener("resize", () => renderer.resetForResize(currentState));
startClock();

if (!isTouch) {
  const ctrl = byId("controls");
  ctrl.style.opacity = "0";
  let idleTimer;
  document.addEventListener("mousemove", () => {
    ctrl.style.opacity = "1";
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { ctrl.style.opacity = "0"; }, 3000);
  });
}

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
  byId("exit-confirm").style.display = "flex";
  setHiddenInteraction(byId("exit-confirm"), false);
  byId("room-status").textContent = "진행 중인 집중을 끝내고 나갈지 확인해 주세요.";
  exitTrap.activate();
  byId("action-bar").style.display = "none";
}

function closeExitConfirm() {
  exitTrap.deactivate({ restore: false });
  setHiddenInteraction(byId("exit-confirm"), true);
  byId("exit-confirm").style.display = "none";
  byId("action-bar").style.display = "";
  byId("room-status").textContent = "나가기를 취소했습니다.";
  setTimeout(() => byId("btn-exit").focus(), 500);
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

setHiddenInteraction(byId("exit-confirm"), true);
socket.connect();
