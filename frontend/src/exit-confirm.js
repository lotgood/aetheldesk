import { byId, createFocusTrap, setHiddenInteraction } from "./dom.js";


export function createExitConfirm({ getState }) {
  const exitConfirm = byId("exit-confirm");
  const exitTrap = createFocusTrap(exitConfirm, {
    initialFocus: byId("btn-exit-no"),
    onCancel: close,
  });

  function open() {
    exitConfirm.style.display = "flex";
    setHiddenInteraction(exitConfirm, false);
    byId("room-status").textContent = "진행 중인 집중을 끝내고 나갈지 확인해 주세요.";
    exitTrap.activate();
    byId("action-bar").style.display = "none";
  }

  function close() {
    exitTrap.deactivate({ restore: false });
    setHiddenInteraction(exitConfirm, true);
    exitConfirm.style.display = "none";
    byId("action-bar").style.display = "";
    byId("room-status").textContent = "나가기를 취소했습니다.";
    setTimeout(() => byId("btn-exit").focus(), 500);
  }

  byId("btn-exit").addEventListener("click", () => {
    const state = getState();
    const active = state && (state.focus || state.break);
    if (active) {
      open();
    } else {
      location.href = "/";
    }
  });
  byId("btn-exit-yes").addEventListener("click", () => { location.href = "/"; });
  byId("btn-exit-no").addEventListener("click", close);

  setHiddenInteraction(exitConfirm, true);
  return { open, close };
}
