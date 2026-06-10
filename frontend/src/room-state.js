import { playChime, tickClock, tickDate } from "./room-renderer.js";


export function createRoomStateApplier({ playlist, renderer, timers, music, intent, checkins, recap, ambience }) {
  let currentState = null;

  function getState() {
    return currentState;
  }

  function applyState(state) {
    const previousState = currentState;
    const prevBreak = previousState?.break;
    currentState = state;

    if (!prevBreak && state.break) playChime();
    if (prevBreak && !state.break) playChime();

    const playlistIndex = playlist.ids.indexOf(state.music.video_id);
    if (playlistIndex !== -1) playlist.index = playlistIndex;

    renderer.applyScene(state.scene);
    renderer.renderCelestial(state.celestial);
    renderer.renderFocus(state.focus, state.pomodoro_remaining, state.break, state.break_remaining, state.paused);
    renderer.renderSatellite(state);
    renderer.renderSessions(state.sessions_done);
    timers.updateDurChips(Math.round(state.pomodoro_duration / 60));
    music.syncYT(state.music);
    intent.renderIntent(state.intent);
    checkins.renderCheckins(state, previousState);
    recap.renderRecap(state.metrics);
    ambience.syncAmbience(state.ambience);
    timers.syncSlider(state);
    tickClock();
    tickDate();
  }

  return { applyState, getState };
}
