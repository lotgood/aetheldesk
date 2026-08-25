import { byId, createFocusTrap, setHiddenInteraction, setModalIsolation } from "./dom.js";

// ─── Display settings popover ────────────────────────────────────────────
// Owns the ⚙ 화면 panel: quality select + FX toggles. All rendering work is
// delegated to the scene controller; this module only manages DOM, Korean
// status announcements, and the focus trap.

const FX_TOGGLES = [
  { key: "bloom", id: "fx-bloom" },
  { key: "shafts", id: "fx-shafts" },
  { key: "grain", id: "fx-grain" },
  { key: "shadows", id: "fx-shadows" },
  { key: "mica", id: "fx-mica" },
];

// Stored overrides are booleans; the engine reports grain as a scale
// number. Both normalize to on/off here.
function toOnOff(value, fallback) {
  if (value === false || value === 0) return false;
  if (value == null) return fallback;
  return true;
}

export function createDisplaySettings({ sceneController, statusEl }) {
  const panel = byId("display-panel");
  const openBtn = byId("btn-display");
  const select = byId("quality-select");
  if (!panel || !openBtn || !select || !sceneController) return null;

  // The controls represent the user's/tier preference. A scene may suppress
  // an unsafe pass at runtime (the ocean bloom case) without flipping the
  // saved toggle or making the control lie about what will return elsewhere.
  const effective = sceneController.getPreferredFX?.() || sceneController.getEffectiveFX();
  const stored = sceneController.getFXOptions();
  const state = {
    bloom: toOnOff(stored.bloom, toOnOff(effective.bloom, true)),
    shafts: toOnOff(stored.shafts, toOnOff(effective.shafts, true)),
    grain: toOnOff(stored.grain, toOnOff(effective.grain, true)),
    shadows: toOnOff(stored.shadows, toOnOff(effective.shadows, true)),
    mica: toOnOff(stored.mica, toOnOff(effective.mica, true)),
  };

  function syncToggles() {
    for (const { key, id } of FX_TOGGLES) {
      byId(id)?.setAttribute("aria-pressed", String(state[key]));
    }
  }

  function pushFX() {
    sceneController.setFXOptions({ ...state });
    syncToggles();
  }

  for (const { key, id } of FX_TOGGLES) {
    byId(id)?.addEventListener("click", () => {
      state[key] = !state[key];
      pushFX();
      if (statusEl) statusEl.textContent = "화면 효과 설정을 바꿨습니다.";
    });
  }

  const q = sceneController.getQuality();
  select.value = q.mode === "auto" ? "auto" : q.tier || "auto";
  select.addEventListener("change", () => {
    sceneController.setQuality(select.value);
    if (statusEl) {
      const label = select.selectedOptions[0]?.textContent || select.value;
      statusEl.textContent = `화질을 ${label}(으)로 바꿨습니다.`;
    }
  });

  const trap = createFocusTrap(panel, {
    initialFocus: () => select,
    onCancel: close,
  });

  function open() {
    window.dispatchEvent(new CustomEvent("aethel:panel-open", { detail: { id: "display-panel" } }));
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
  byId("display-panel-close")?.addEventListener("click", close);
  window.addEventListener("aethel:panel-open", event => {
    if (event.detail?.id !== "display-panel" && panel.style.display !== "none") close();
  });

  syncToggles();
  setHiddenInteraction(panel, true);

  return { open, close };
}
