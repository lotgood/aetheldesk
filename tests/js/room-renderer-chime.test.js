import test from "node:test";
import assert from "node:assert/strict";

import { playChime } from "../../frontend/src/room-renderer.js";


test("completion chime closes its AudioContext after the final note", async () => {
  const contexts = [];

  class FakeOscillator {
    constructor() {
      this.frequency = { value: 0 };
      this.listeners = new Map();
      this.type = "";
    }

    connect() {}
    start() {}
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    stop() { queueMicrotask(() => this.listeners.get("ended")?.()); }
  }

  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
      this.closeCalls = 0;
      contexts.push(this);
    }

    createOscillator() { return new FakeOscillator(); }
    createGain() {
      return {
        connect() {},
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
      };
    }
    close() {
      this.closeCalls += 1;
      return Promise.resolve();
    }
  }

  const previousWindow = globalThis.window;
  globalThis.window = { AudioContext: FakeAudioContext };
  try {
    playChime();
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    globalThis.window = previousWindow;
  }

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].closeCalls, 1);
});
