import { tokenStorageKey } from "./src/storage.js";
import { startLobbySky } from "./src/lobby-sky.js";

function randCode() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function showLobbyError(message) { document.getElementById("lobby-error").textContent = message || ""; }
function readPin() { return document.getElementById("pin-input").value.trim(); }
function clearPin() { document.getElementById("pin-input").value = ""; }
function go(code) { if (code) location.href = `/room/${code.toUpperCase()}`; }

async function createRoom() {
  const requestedRoomId = document.getElementById("room-input").value.trim().toUpperCase();
  const roomId = requestedRoomId || randCode();
  const pin = readPin();
  if (!pin) { document.getElementById("pin-input").focus(); return; }
  showLobbyError("");
  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room_id: roomId, pin }),
    });
    if (!response.ok) throw new Error("room rejected");
    const data = await response.json();
    const nextRoomId = String(data.room_id || roomId).toUpperCase();
    sessionStorage.setItem(tokenStorageKey(nextRoomId), data.token);
    go(nextRoomId);
  } catch (_) {
    showLobbyError("입장할 수 없습니다");
  } finally {
    clearPin();
  }
}

async function joinRoom() {
  const roomId = document.getElementById("room-input").value.trim().toUpperCase();
  const pin = readPin();
  if (!roomId) { document.getElementById("room-input").focus(); return; }
  if (!pin) { document.getElementById("pin-input").focus(); return; }
  showLobbyError("");
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (!response.ok) throw new Error("room rejected");
    const data = await response.json();
    sessionStorage.setItem(tokenStorageKey(roomId), data.token);
    go(roomId);
  } catch (_) {
    showLobbyError("입장할 수 없습니다");
  } finally {
    clearPin();
  }
}

startLobbySky();
document.getElementById("btn-start").addEventListener("click", createRoom);
document.getElementById("btn-join").addEventListener("click", joinRoom);

let codeOpen = false;
document.getElementById("code-toggle").addEventListener("click", () => {
  codeOpen = !codeOpen;
  const section = document.getElementById("code-section");
  section.style.maxHeight = codeOpen ? "120px" : "0";
  section.style.opacity = codeOpen ? "1" : "0";
  section.style.pointerEvents = codeOpen ? "auto" : "none";
  if (codeOpen) setTimeout(() => document.getElementById("room-input").focus(), 380);
});

document.getElementById("room-input").addEventListener("keydown", event => {
  if (event.key === "Enter") joinRoom();
});
document.getElementById("pin-input").addEventListener("keydown", event => {
  if (event.key === "Enter") codeOpen ? joinRoom() : createRoom();
});
