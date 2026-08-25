import { byId, createFocusTrap, setHiddenInteraction, setModalIsolation } from "./dom.js";

const SCENE_LABELS = {
  sky: "해변 하늘",
  city: "도시",
  forest: "숲",
};

export function createScenePicker({ sceneController, statusEl }) {
  const panel = byId("scene-panel");
  const openBtn = byId("btn-scene");
  const closeBtn = byId("scene-panel-close");
  const label = byId("scene-label");
  const options = [...panel.querySelectorAll("[data-scene]")];

  function sync() {
    const active = sceneController.getActiveScene();
    const activeLabel = SCENE_LABELS[active] || SCENE_LABELS.sky;
    if (label) label.textContent = activeLabel;
    openBtn.setAttribute("aria-label", `장면 선택: ${activeLabel}`);
    for (const option of options) {
      option.setAttribute("aria-pressed", String(option.dataset.scene === active));
    }
  }

  const trap = createFocusTrap(panel, {
    initialFocus: () => options.find(option => option.getAttribute("aria-pressed") === "true") || options[0],
    onCancel: close,
  });

  function open() {
    window.dispatchEvent(new CustomEvent("aethel:panel-open", { detail: { id: "scene-panel" } }));
    sync();
    panel.style.display = "flex";
    setHiddenInteraction(panel, false);
    openBtn.setAttribute("aria-expanded", "true");
    document.body.classList.add("panel-open");
    setModalIsolation(panel, true);
    trap.activate();
  }

  function close() {
    setModalIsolation(panel, false);
    trap.deactivate();
    setHiddenInteraction(panel, true);
    panel.style.display = "none";
    openBtn.setAttribute("aria-expanded", "false");
    document.body.classList.remove("panel-open");
  }

  openBtn.addEventListener("click", () => {
    if (panel.style.display === "none") open();
    else close();
  });
  closeBtn.addEventListener("click", close);

  for (const option of options) {
    option.addEventListener("click", async () => {
      const next = option.dataset.scene;
      panel.setAttribute("aria-busy", "true");
      for (const candidate of options) candidate.disabled = true;
      try {
        const resolved = await sceneController.switchScene(next);
        sync();
        if (statusEl) {
          statusEl.textContent = resolved === next
            ? `${SCENE_LABELS[resolved]} 장면으로 바꿨습니다.`
            : `${SCENE_LABELS[next]} 장면을 표시하지 못해 ${SCENE_LABELS[resolved]} 장면으로 돌아왔습니다.`;
        }
        close();
      } finally {
        panel.removeAttribute("aria-busy");
        for (const candidate of options) candidate.disabled = false;
      }
    });
  }

  // A scene can fail after selection during its first frame or light update.
  // Keep the picker, persistence and ambience aligned with the manager's
  // runtime fallback instead of continuing to announce a scene no longer on
  // screen.
  const unsubscribe = sceneController.onSceneChange?.(detail => {
    sync();
    if (detail.fallback && statusEl) {
      statusEl.textContent = detail.reason === "engine-fallback"
        ? "3D 장면에 문제가 있어 기본 하늘 화면으로 전환했습니다."
        : `${SCENE_LABELS[detail.requested]} 장면에 문제가 있어 ${SCENE_LABELS[detail.active]} 장면으로 돌아왔습니다.`;
    }
  });

  window.addEventListener("aethel:panel-open", event => {
    if (event.detail?.id !== "scene-panel" && panel.style.display !== "none") close();
  });

  sync();
  setHiddenInteraction(panel, true);
  return { open, close, sync, destroy: () => unsubscribe?.() };
}
