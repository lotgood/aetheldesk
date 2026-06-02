import { createSceneController } from "./scenes.js";
import { byId } from "./src/dom.js";
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
  auth: {
    show(message) {
      socket?.clearReconnect();
      byId("conn-dot").style.opacity = "0";
      auth.show(message);
    },
    hide: auth.hide,
  },
  onState: applyState,
});

const timers = createTimerControls({ getState: () => currentState, send: msg => socket.send(msg) });
const music = createMusicController({ playlist, getState: () => currentState, send: msg => socket.send(msg) });

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
  navigator.geolocation?.getCurrentPosition(
    pos => socket.send({ type: "location", lat: pos.coords.latitude, lon: pos.coords.longitude }),
    () => {}
  );
});

byId("btn-exit").addEventListener("click", () => {
  const active = currentState && (currentState.focus || currentState.break);
  if (active) {
    byId("action-bar").style.display = "none";
    byId("exit-confirm").style.display = "flex";
  } else {
    location.href = "/";
  }
});
byId("btn-exit-yes").addEventListener("click", () => { location.href = "/"; });
byId("btn-exit-no").addEventListener("click", () => {
  byId("exit-confirm").style.display = "none";
  byId("action-bar").style.display = "";
});

socket.connect();
