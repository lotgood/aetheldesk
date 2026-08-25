import { tokenStorageKey } from "./src/storage.js";
import { startLobbySky } from "./src/lobby-sky.js";

function randCode() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function showLobbyError(message, state = "error") {
  const status = document.getElementById("lobby-error");
  status.textContent = message || "";
  status.dataset.state = message ? state : "";
}
function readPin() { return document.getElementById("pin-input").value.trim(); }
function clearPin() { document.getElementById("pin-input").value = ""; }
function go(code) { if (code) location.href = `/room/${code.toUpperCase()}`; }

let pending = false;
function setPending(next, message = "") {
  pending = next;
  const panel = document.querySelector(".entry-panel");
  panel.setAttribute("aria-busy", String(next));
  for (const id of ["btn-start", "btn-join", "code-toggle", "pin-input", "room-input"]) {
    document.getElementById(id).disabled = next;
  }
  if (next) showLobbyError(message, "pending");
}

function validatePin(pin) {
  const input = document.getElementById("pin-input");
  const valid = pin.length >= 4;
  input.setAttribute("aria-invalid", String(!valid));
  if (!valid) {
    showLobbyError("PIN은 4자 이상 입력해 주세요");
    input.focus();
  }
  return valid;
}

async function createRoom() {
  if (pending) return;
  const roomId = randCode();
  const pin = readPin();
  if (!validatePin(pin)) return;
  showLobbyError("");
  setPending(true, "새 방을 준비하고 있어요…");
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
    setPending(false);
    clearPin();
  }
}

async function joinRoom() {
  if (pending) return;
  const roomId = document.getElementById("room-input").value.trim().toUpperCase();
  const pin = readPin();
  const roomInput = document.getElementById("room-input");
  if (!/^[A-Z0-9]{1,64}$/.test(roomId)) {
    showLobbyError("방 코드를 입력해 주세요");
    roomInput.setAttribute("aria-invalid", "true");
    roomInput.focus();
    return;
  }
  roomInput.setAttribute("aria-invalid", "false");
  if (!validatePin(pin)) return;
  showLobbyError("");
  setPending(true, "방에 연결하고 있어요…");
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
    setPending(false);
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
  const toggle = document.getElementById("code-toggle");
  const roomInput = document.getElementById("room-input");
  const joinButton = document.getElementById("btn-join");
  section.classList.toggle("is-open", codeOpen);
  section.style.maxHeight = codeOpen ? "190px" : "0";
  section.style.opacity = codeOpen ? "1" : "0";
  section.style.pointerEvents = codeOpen ? "auto" : "none";
  section.setAttribute("aria-hidden", codeOpen ? "false" : "true");
  toggle.setAttribute("aria-expanded", codeOpen ? "true" : "false");
  roomInput.tabIndex = codeOpen ? 0 : -1;
  joinButton.tabIndex = codeOpen ? 0 : -1;
  if (codeOpen) setTimeout(() => roomInput.focus(), 380);
});

document.getElementById("room-input").addEventListener("keydown", event => {
  if (event.key === "Enter") joinRoom();
});
document.getElementById("room-input").addEventListener("input", event => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 64);
  event.target.setAttribute("aria-invalid", "false");
});
document.getElementById("pin-input").addEventListener("input", event => {
  event.target.setAttribute("aria-invalid", "false");
});
document.getElementById("pin-input").addEventListener("keydown", event => {
  if (event.key === "Enter") codeOpen ? joinRoom() : createRoom();
});
