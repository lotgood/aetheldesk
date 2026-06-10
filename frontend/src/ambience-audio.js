import { byId, setHiddenInteraction } from "./dom.js";

const LAYER_GAIN = { rain: 0.22, wind: 0.16, brown_noise: 0.2 };
const DEFAULT_LAYER_VOLUME = { rain: 35, wind: 0, brown_noise: 25 };
const FILTERS = {
  rain: { type: "highpass", frequency: 900 },
  wind: { type: "lowpass", frequency: 500 },
  brown_noise: { type: "lowpass", frequency: 160 },
};


function makeNoiseBuffer(ctx) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = Math.random() * 2 - 1;
  }
  return buffer;
}


function createLayer(ctx, destination, layer) {
  const source = ctx.createBufferSource();
  source.buffer = makeNoiseBuffer(ctx);
  source.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = FILTERS[layer].type;
  filter.frequency.value = FILTERS[layer].frequency;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  source.start();
  return gain;
}


export function createAmbienceController({ getState, send }) {
  const panel = byId("ambience-panel");
  const toggleButton = byId("btn-ambience");
  const enabledInput = byId("ambience-enabled");
  const status = byId("ambience-status");
  const sliders = [...document.querySelectorAll("[data-ambience-layer]")];
  let ctx = null;
  let master = null;
  let gains = null;

  function setStatus(message) {
    status.textContent = message;
  }

  function sliderLayerValues() {
    return Object.fromEntries(sliders.map(slider => [slider.dataset.ambienceLayer, Number(slider.value)]));
  }

  function hasAudibleLayer(layers) {
    return Object.values(layers).some(volume => volume > 0);
  }

  function setSliderValue(layer, volume) {
    const slider = sliders.find(item => item.dataset.ambienceLayer === layer);
    if (!slider) return;
    slider.value = String(volume);
    slider.setAttribute("aria-valuetext", `${volume}%`);
  }

  function primeDefaultMixIfSilent() {
    if (hasAudibleLayer(getState()?.ambience?.layers || {}) || hasAudibleLayer(sliderLayerValues())) return false;
    for (const [layer, volume] of Object.entries(DEFAULT_LAYER_VOLUME)) {
      setSliderValue(layer, volume);
      if (volume > 0) send({ type: "ambience_set_layer", layer, volume });
    }
    return true;
  }

  function ensureAudio() {
    if (ctx) {
      ctx.resume?.();
      return;
    }
    const AudioContextCtor = window.AudioContext || window["webkit" + "AudioContext"];
    if (!AudioContextCtor) return;
    ctx = new AudioContextCtor();
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);
    gains = Object.fromEntries(Object.keys(LAYER_GAIN).map(layer => [layer, createLayer(ctx, master, layer)]));
  }

  function setPanelOpen(open) {
    panel.hidden = !open;
    setHiddenInteraction(panel, !open);
    toggleButton.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) ensureAudio();
  }

  function applyAudio(ambience) {
    if (!gains) return;
    for (const [layer, gain] of Object.entries(gains)) {
      const volume = ambience.enabled ? ambience.layers[layer] / 100 * LAYER_GAIN[layer] : 0;
      gain.gain.setTargetAtTime(volume, ctx.currentTime, 0.08);
    }
  }

  function syncAmbience(ambience) {
    enabledInput.checked = ambience.enabled;
    for (const slider of sliders) {
      const layer = slider.dataset.ambienceLayer;
      if (document.activeElement !== slider) slider.value = String(ambience.layers[layer]);
      slider.setAttribute("aria-valuetext", `${ambience.layers[layer]}%`);
    }
    applyAudio(ambience);
  }

  toggleButton.addEventListener("click", () => setPanelOpen(panel.hidden));
  byId("ambience-close").addEventListener("click", () => setPanelOpen(false));
  enabledInput.addEventListener("change", () => {
    ensureAudio();
    const enabled = enabledInput.checked;
    const primedDefaultMix = enabled && primeDefaultMixIfSilent();
    send({ type: "ambience_set_enabled", enabled });
    const statusMessage = primedDefaultMix
      ? "주변 소리를 기본 믹스로 켰습니다."
      : enabled
        ? "주변 소리를 켰습니다."
        : "주변 소리를 껐습니다.";
    setStatus(statusMessage);
  });
  sliders.forEach(slider => {
    slider.addEventListener("input", () => {
      ensureAudio();
      send({ type: "ambience_set_layer", layer: slider.dataset.ambienceLayer, volume: Number(slider.value) });
      setStatus("주변 소리 설정을 동기화했습니다.");
    });
  });

  setHiddenInteraction(panel, true);
  return { syncAmbience };
}
