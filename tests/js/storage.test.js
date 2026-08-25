import assert from "node:assert/strict";
import test from "node:test";

import { migrateLegacyPlaylistStorage } from "../../frontend/src/storage.js";

test("retired playlist storage is deleted without touching current preferences", () => {
  const values = new Map([
    ["playlist", JSON.stringify(["legacy-video-id"])],
    ["scene", "forest"],
    ["next-intent", "continue"],
  ]);
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    removeItem: key => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };

  migrateLegacyPlaylistStorage();

  assert.equal(values.has("playlist"), false);
  assert.equal(values.get("scene"), "forest");
  assert.equal(values.get("next-intent"), "continue");
});
