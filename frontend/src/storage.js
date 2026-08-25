export const SCENE_STORAGE_KEY = "scene";
export const NEXT_INTENT_STORAGE_KEY = "next-intent";

const NEXT_INTENT_VALUES = new Set(["continue", "next", "finish"]);

export function migrateLegacyPlaylistStorage() {
  // The shared YouTube player was retired. Remove its user-specific residue
  // once the current room boots instead of leaving a dead playlist forever.
  localStorage.removeItem("playlist");
}

export function tokenStorageKey(roomId) { return `room_token:${roomId}`; }
export function readRoomToken(roomId) { return sessionStorage.getItem(tokenStorageKey(roomId)); }
export function storeRoomToken(roomId, token) { sessionStorage.setItem(tokenStorageKey(roomId), token); }
export function clearRoomToken(roomId) { sessionStorage.removeItem(tokenStorageKey(roomId)); }

export function readScene(defaultScene = "sky") {
  return localStorage.getItem(SCENE_STORAGE_KEY) || defaultScene;
}

export function storeScene(name) {
  localStorage.setItem(SCENE_STORAGE_KEY, name);
}

export function readNextIntent() {
  const value = localStorage.getItem(NEXT_INTENT_STORAGE_KEY);
  if (NEXT_INTENT_VALUES.has(value)) return value;
  if (value !== null) localStorage.removeItem(NEXT_INTENT_STORAGE_KEY);
  return null;
}

export function storeNextIntent(value) {
  if (!NEXT_INTENT_VALUES.has(value)) {
    localStorage.removeItem(NEXT_INTENT_STORAGE_KEY);
    return null;
  }
  localStorage.setItem(NEXT_INTENT_STORAGE_KEY, value);
  return value;
}

export const DISPLAY_QUALITY_STORAGE_KEY = "display-quality";
export const DISPLAY_FX_STORAGE_KEY = "display-fx";

export function readDisplayQuality() {
  return localStorage.getItem(DISPLAY_QUALITY_STORAGE_KEY) || "auto";
}

export function storeDisplayQuality(name) {
  localStorage.setItem(DISPLAY_QUALITY_STORAGE_KEY, name);
}

export function readDisplayFX() {
  try {
    const value = JSON.parse(localStorage.getItem(DISPLAY_FX_STORAGE_KEY) || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    localStorage.removeItem(DISPLAY_FX_STORAGE_KEY);
    return null;
  }
}

export function storeDisplayFX(fx) {
  localStorage.setItem(DISPLAY_FX_STORAGE_KEY, JSON.stringify(fx));
}
