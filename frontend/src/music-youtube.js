import { byId, setHiddenInteraction } from "./dom.js";
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

  function hideYouTubeFrame() {
    const frame = ytPlayer?.getIframe?.() || byId("yt-frame");
    frame?.setAttribute("aria-hidden", "true");
    frame?.setAttribute("tabindex", "-1");
    frame?.toggleAttribute("inert", true);
  }

  function showMusicBar() {
    const bar = byId("music-bar");
    bar.style.position = "static";
    bar.style.bottom = "";
    bar.style.opacity = "1";
    bar.style.pointerEvents = "auto";
    bar.style.transform = "translateY(0)";
    setHiddenInteraction(bar, false);
  }

  function loadVideo(id) {
    pendingVideoId = id;
    ytPlayer.loadVideoById(id);
  }

  function syncYT(music) {
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
    actionBarEl.style.display = "none";
    trackRowEl.style.display = "flex";
    setHiddenInteraction(trackRowEl, false);
    trackInput.value = "";
    trackInput.style.borderBottomColor = "";
    trackError.textContent = "";
    setTimeout(() => trackInput.focus(), 50);
  }

  function closeTrackRow() {
    setHiddenInteraction(trackRowEl, true);
    trackRowEl.style.display = "none";
    actionBarEl.style.display = "";
    trackError.textContent = "";
  }

  function submitTrack() {
    const id = parseYtId(trackInput.value.trim());
    if (!id) {
      trackInput.style.borderBottomColor = "rgba(255,80,80,0.7)";
      trackError.textContent = "YouTube 링크 또는 11자리 영상 ID를 입력해 주세요.";
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
    playlist.index = (playlist.index + 1) % playlist.ids.length;
    const id = playlist.ids[playlist.index];
    if (ytReady && ytPlayer) loadVideo(id);
    send({ type: "music_skip", video_id: id });
  });

  setHiddenInteraction(byId("music-bar"), true);
  setHiddenInteraction(trackRowEl, true);
  if (playlist.savedPlaylist) showMusicBar();

  return { syncYT };
}
