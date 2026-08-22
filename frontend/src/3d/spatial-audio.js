export function createSpatialAudio() {
  let ctx = null;
  let masterGain = null;
  let activeNodes = {};
  let isMuted = false;

  function initAudio() {
    if (ctx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    ctx = new AudioCtx();
    masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.35, ctx.currentTime);
    masterGain.connect(ctx.destination);
  }

  function startSceneAmbience(sceneName) {
    initAudio();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume();
    }

    stopAllAmbience();

    if (sceneName === "forest") {
      activeNodes.fire = createCampfireSound();
    } else if (sceneName === "beach") {
      activeNodes.waves = createOceanWavesSound();
    } else if (sceneName === "city") {
      activeNodes.rain = createRainSound();
    } else if (sceneName === "sky") {
      activeNodes.wind = createWindSound();
    }
  }

  function stopAllAmbience() {
    for (const [key, node] of Object.entries(activeNodes)) {
      if (node && node.stop) node.stop();
    }
    activeNodes = {};
  }

  // 1. Procedural Wind
  function createWindSound() {
    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;
    whiteNoise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(320, ctx.currentTime);
    filter.Q.setValueAtTime(3.0, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.08, ctx.currentTime);

    whiteNoise.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    whiteNoise.start();

    // Slow wind modulation
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(0.15, ctx.currentTime);
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(140, ctx.currentTime);
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    return {
      stop() {
        try {
          whiteNoise.stop();
          lfo.stop();
        } catch (_) {}
      }
    };
  }

  // 2. Procedural Ocean Waves
  function createOceanWavesSound() {
    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;
    whiteNoise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(240, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, ctx.currentTime);

    whiteNoise.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    whiteNoise.start();

    // Wave swell LFO
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(0.12, ctx.currentTime); // ~8 sec wave cycle
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0.08, ctx.currentTime);
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    lfo.start();

    return {
      stop() {
        try {
          whiteNoise.stop();
          lfo.stop();
        } catch (_) {}
      }
    };
  }

  // 3. Procedural Rain
  function createRainSound() {
    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;
    whiteNoise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(900, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.09, ctx.currentTime);

    whiteNoise.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    whiteNoise.start();

    return {
      stop() {
        try {
          whiteNoise.stop();
        } catch (_) {}
      }
    };
  }

  // 4. Procedural Campfire Crackle
  function createCampfireSound() {
    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;
    whiteNoise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(450, ctx.currentTime);
    filter.Q.setValueAtTime(2.0, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.07, ctx.currentTime);

    whiteNoise.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    whiteNoise.start();

    return {
      stop() {
        try {
          whiteNoise.stop();
        } catch (_) {}
      }
    };
  }

  return {
    initAudio,
    startSceneAmbience,
    stopAllAmbience,
  };
}
