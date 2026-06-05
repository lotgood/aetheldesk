import { playChime, tickClock, tickDate } from "./room-renderer.js";


export function createRoomStateApplier({ playlist, renderer, timers, music }) {
  let currentState = null;

  function getState() {
    return currentState;
  }

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

  return { applyState, getState };
}
