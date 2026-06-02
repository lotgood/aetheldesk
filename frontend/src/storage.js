export const DEFAULT_PLAYLIST_IDS = ["jfKfPfyJRdk", "5qap5aO4i9A", "DWcJFNfaw9c"];
export const PLAYLIST_STORAGE_KEY = "playlist";
export const SCENE_STORAGE_KEY = "scene";

export function tokenStorageKey(roomId) { return `room_token:${roomId}`; }
export function readRoomToken(roomId) { return sessionStorage.getItem(tokenStorageKey(roomId)); }
export function storeRoomToken(roomId, token) { sessionStorage.setItem(tokenStorageKey(roomId), token); }
export function clearRoomToken(roomId) { sessionStorage.removeItem(tokenStorageKey(roomId)); }

export function readPlaylist() {
  try {
    const value = JSON.parse(localStorage.getItem(PLAYLIST_STORAGE_KEY) || "null");
    return Array.isArray(value) && value.length ? value : null;
  } catch {
    localStorage.removeItem(PLAYLIST_STORAGE_KEY);
    return null;
  }
}

export function storePlaylist(ids) {
  localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(ids));
}

export function createPlaylistState() {
  const savedPlaylist = readPlaylist();
  return {
    savedPlaylist,
    ids: savedPlaylist || [...DEFAULT_PLAYLIST_IDS],
    index: 0,
  };
}

export function readScene(defaultScene = "sky") {
  return localStorage.getItem(SCENE_STORAGE_KEY) || defaultScene;
}

export function storeScene(name) {
  localStorage.setItem(SCENE_STORAGE_KEY, name);
}
