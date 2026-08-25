import { byId, createFocusTrap, hideFlex, setModalIsolation, showFlex } from "./dom.js";
import { clearRoomToken, storeRoomToken } from "./storage.js";

export function createRoomAuth(roomId, onAuthenticated) {
  const authPrompt = byId("room-auth");
  const roomPinInput = byId("room-pin-input");
  const roomAuthError = byId("room-auth-error");
  const roomPinSubmit = byId("room-pin-submit");
  let pending = false;
  const authTrap = createFocusTrap(authPrompt, {
    initialFocus: roomPinInput,
    onCancel: () => roomPinInput.focus(),
  });

  function show(message) {
    window.dispatchEvent(new CustomEvent("aethel:panel-open", { detail: { id: "room-auth" } }));
    showFlex(authPrompt);
    document.body.classList.add("panel-open");
    setModalIsolation(authPrompt, true);
    roomAuthError.textContent = message || "";
    roomPinInput.value = "";
    roomPinInput.setAttribute("aria-invalid", message ? "true" : "false");
    authTrap.activate();
  }

  function hide() {
    setModalIsolation(authPrompt, false);
    authTrap.deactivate();
    hideFlex(authPrompt);
    document.body.classList.remove("panel-open");
    roomAuthError.textContent = "";
    roomPinInput.value = "";
    roomPinInput.removeAttribute("aria-invalid");
  }

  function setPending(next) {
    pending = next;
    roomPinSubmit.disabled = next;
    roomPinInput.disabled = next;
    authPrompt.setAttribute("aria-busy", String(next));
    roomPinSubmit.textContent = next ? "확인 중…" : "방에 입장";
  }

  async function joinRoomWithPin() {
    if (pending) return;
    const pin = roomPinInput.value.trim();
    if (!pin) {
      roomPinInput.focus();
      return;
    }
    roomAuthError.textContent = "";
    roomPinInput.setAttribute("aria-invalid", "false");
    setPending(true);
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
      roomAuthError.textContent = "입장할 수 없습니다";
      roomPinInput.setAttribute("aria-invalid", "true");
    } finally {
      setPending(false);
      roomPinInput.value = "";
      if (!authPrompt.classList.contains("hidden")) roomPinInput.focus();
    }
  }

  roomPinSubmit.addEventListener("click", joinRoomWithPin);
  roomPinInput.addEventListener("keydown", event => {
    if (event.key === "Enter") joinRoomWithPin();
  });

  return { show, hide };
}
