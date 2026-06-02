import { byId, createFocusTrap, hideFlex, showFlex } from "./dom.js";
import { clearRoomToken, storeRoomToken } from "./storage.js";

export function createRoomAuth(roomId, onAuthenticated) {
  const authPrompt = byId("room-auth");
  const roomPinInput = byId("room-pin-input");
  const roomAuthError = byId("room-auth-error");
  const roomPinSubmit = byId("room-pin-submit");
  const authTrap = createFocusTrap(authPrompt, {
    initialFocus: roomPinInput,
    onCancel: () => roomPinInput.focus(),
  });

  function show(message) {
    showFlex(authPrompt);
    roomAuthError.textContent = message || "";
    roomPinInput.value = "";
    authTrap.activate();
  }

  function hide() {
    authTrap.deactivate();
    hideFlex(authPrompt);
    roomAuthError.textContent = "";
    roomPinInput.value = "";
  }

  async function joinRoomWithPin() {
    const pin = roomPinInput.value.trim();
    if (!pin) {
      roomPinInput.focus();
      return;
    }
    roomAuthError.textContent = "";
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (!response.ok) throw new Error("room rejected");
      const data = await response.json();
      storeRoomToken(roomId, data.token);
      hide();
      onAuthenticated();
    } catch (_) {
      clearRoomToken(roomId);
      show("입장할 수 없습니다");
    } finally {
      roomPinInput.value = "";
    }
  }

  roomPinSubmit.addEventListener("click", joinRoomWithPin);
  roomPinInput.addEventListener("keydown", event => {
    if (event.key === "Enter") joinRoomWithPin();
  });

  return { show, hide };
}
