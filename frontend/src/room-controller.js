import { createSceneController } from "../scenes.js";
import { byId } from "./dom.js";
import { createExitConfirm } from "./exit-confirm.js";
import { createAmbienceController } from "./ambience-audio.js";
import { bindLocationStatus } from "./location-status.js";
import { createMusicController } from "./music-youtube.js";
import { createRoomCheckinsController } from "./room-checkins.js";
import { createRoomIntentController } from "./room-intent.js";
import { createRoomConnection } from "./room-connection.js";
import { createRoomRecapController } from "./room-recap.js";
import { createRoomRenderer, startClock } from "./room-renderer.js";
import { createRoomStateApplier } from "./room-state.js";
import { createPlaylistState } from "./storage.js";
import { createTimerControls } from "./timer-controls.js";


export function startRoomApp() {
  const roomId = location.pathname.split("/").pop().toUpperCase();
  byId("room-label").textContent = `# ${roomId}`;

  const isTouch = navigator.maxTouchPoints > 0 || window.matchMedia?.("(pointer: coarse)").matches === true;
  if (isTouch) document.body.classList.add("touch");

  let socket;
  let getCurrentState = () => null;
  const send = msg => socket.send(msg);
  const playlist = createPlaylistState();
  const sceneController = createSceneController({ send });
  const renderer = createRoomRenderer({ sceneController });
  const timers = createTimerControls({ getState: () => getCurrentState(), send });
  const music = createMusicController({ playlist, getState: () => getCurrentState(), send });
  const intent = createRoomIntentController({ getState: () => getCurrentState(), send });
  const checkins = createRoomCheckinsController({ getState: () => getCurrentState(), send });
  const recap = createRoomRecapController();
  const ambience = createAmbienceController({ getState: () => getCurrentState(), send });
  const roomState = createRoomStateApplier({ playlist, renderer, timers, music, intent, checkins, recap, ambience });
  getCurrentState = roomState.getState;

  socket = createRoomConnection({ roomId, onState: roomState.applyState });
  bindLocationStatus({ send });
  createExitConfirm({ getState: roomState.getState });
  bindDesktopControlAutoHide({ isTouch });
  window.addEventListener("resize", () => renderer.resetForResize(roomState.getState()));
  startClock();
  socket.connect();
}


function bindDesktopControlAutoHide({ isTouch }) {
  if (isTouch) return;
  const ctrl = byId("controls");
  ctrl.style.opacity = "0";
  let idleTimer;
  document.addEventListener("mousemove", () => {
    ctrl.style.opacity = "1";
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { ctrl.style.opacity = "0"; }, 3000);
  });
}
