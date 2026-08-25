import { byId, createFocusTrap, setHiddenInteraction, setModalIsolation } from "./dom.js";
import { storePlaylist } from "./storage.js";

export function parseYtId(input) {
  const match = input.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  return null;
}

export function createMusicController({ playlist, getState, send }) {
  let ytPlayer = null;
  let ytReady = false;
  let pendingVideoId = null;
  const trackInput = byId("track-input");
  const trackError = byId("track-error");
  const actionBarEl = byId("action-bar");
  const trackRowEl = byId("track-row");
  const trackTrap = createFocusTrap(trackRowEl, {
    initialFocus: trackInput,
    onCancel: closeTrackRow,
  });

  function hideYouTubeFrame() {
    const frame = ytPlayer?.getIframe?.() || byId("yt-frame");
    frame?.setAttribute("aria-hidden", "true");
    frame?.setAttribute("tabindex", "-1");
    frame?.toggleAttribute("inert", true);
  }

  function showMusicBar() {
    const bar = byId("music-bar");
    bar.style.opacity = "1";
    bar.style.pointerEvents = "auto";
    bar.style.transform = "translateY(0)";
    setHiddenInteraction(bar, false);
  }

  function syncPlaybackControls(playing) {
    const play = byId("btn-play");
    const pause = byId("btn-pause");
    play.style.display = playing ? "none" : "inline-flex";
    pause.style.display = playing ? "inline-flex" : "none";
    setHiddenInteraction(play, playing);
    setHiddenInteraction(pause, !playing);
  }

  function loadVideo(id) {
    pendingVideoId = id;
    ytPlayer.loadVideoById(id);
  }

  function syncYT(music) {
    const eq = byId("eq");
    if (eq) eq.classList.toggle("hidden", !music.playing);
    // Music is shared room state. Every participant must retain visible
    // playback controls, even when the track originated on another client.
    showMusicBar();
    syncPlaybackControls(music.playing);
    if (!ytReady || !ytPlayer) return;
    if (music.playing) {
      if (music.video_id === pendingVideoId) {
        pendingVideoId = null;
        ytPlayer.playVideo();
      } else if (ytPlayer.getVideoData?.()?.video_id !== music.video_id) {
        loadVideo(music.video_id);
      } else {
        ytPlayer.playVideo();
      }
    } else {
      pendingVideoId = null;
      ytPlayer.pauseVideo();
    }
  }

  function initYouTubePlayer() {
    if (ytPlayer || !window.YT?.Player) return;
    ytPlayer = new YT.Player("yt-frame", {
      videoId: getState()?.music?.video_id ?? "jfKfPfyJRdk",
      playerVars: { autoplay: 0, controls: 0, playsinline: 1 },
      events: { onReady: () => { hideYouTubeFrame(); ytReady = true; if (getState()) syncYT(getState().music); } },
    });
    hideYouTubeFrame();
    setTimeout(hideYouTubeFrame, 0);
  }

  window.onYouTubeIframeAPIReady = initYouTubePlayer;
  initYouTubePlayer();

  function openTrackRow() {
    window.dispatchEvent(new CustomEvent("aethel:panel-open", { detail: { id: "track-row" } }));
    actionBarEl.style.display = "none";
    trackRowEl.style.display = "flex";
    setHiddenInteraction(trackRowEl, false);
    document.body.classList.add("panel-open");
    document.body.classList.add("track-panel-open");
    setModalIsolation(trackRowEl, true);
    trackInput.value = "";
    trackInput.setAttribute("aria-invalid", "false");
    trackError.textContent = "";
    trackTrap.activate();
  }

  function closeTrackRow() {
    setModalIsolation(trackRowEl, false);
    setHiddenInteraction(trackRowEl, true);
    trackRowEl.style.display = "none";
    actionBarEl.style.display = "";
    trackError.textContent = "";
    trackInput.setAttribute("aria-invalid", "false");
    document.body.classList.remove("panel-open");
    document.body.classList.remove("track-panel-open");
    trackTrap.deactivate();
  }

  function submitTrack() {
    const id = parseYtId(trackInput.value.trim());
    if (!id) {
      trackInput.setAttribute("aria-invalid", "true");
      trackError.textContent = "YouTube 링크 또는 11자리 영상 ID를 입력해 주세요.";
      trackInput.focus();
      return;
    }
    if (!playlist.ids.includes(id)) {
      if (playlist.ids.length >= 50) playlist.ids.splice(0, 1);
      playlist.ids.push(id);
      storePlaylist(playlist.ids);
    }
    playlist.index = playlist.ids.indexOf(id);
    if (ytReady && ytPlayer) loadVideo(id);
    send({ type: "music_skip", video_id: id });
    send({ type: "music_play" });
    closeTrackRow();
    showMusicBar();
  }

  byId("btn-add-track").addEventListener("click", openTrackRow);
  byId("track-add").addEventListener("click", submitTrack);
  byId("track-cancel").addEventListener("click", closeTrackRow);
  trackInput.addEventListener("keydown", event => {
    if (event.key === "Enter") submitTrack();
    else if (event.key === "Escape") closeTrackRow();
  });
  byId("btn-play").addEventListener("click", () => send({ type: "music_play" }));
  byId("btn-pause").addEventListener("click", () => send({ type: "music_pause" }));
  byId("btn-skip").addEventListener("click", () => {
    if (playlist.ids.length === 0) return;
    playlist.index = (playlist.index + 1) % playlist.ids.length;
    const id = playlist.ids[playlist.index];
    if (ytReady && ytPlayer) loadVideo(id);
    send({ type: "music_skip", video_id: id });
  });
  window.addEventListener("aethel:panel-open", event => {
    if (event.detail?.id !== "track-row" && trackRowEl.style.display !== "none") closeTrackRow();
  });

  setHiddenInteraction(byId("music-bar"), true);
  setHiddenInteraction(trackRowEl, true);
  showMusicBar();
  syncPlaybackControls(false);

  return { syncYT };
}
