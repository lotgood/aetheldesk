import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  NEXT_INTENT_CHOICES,
  RECOVERY_CHOICES,
  REST_PHASE,
  createRewardRevealTracker,
  deriveRestRitualState,
  getBreakDurationSeconds,
  getCycleProgress,
  normalizeRewardId,
} from "../../frontend/src/rest-ritual.js";

const SOURCE = readFileSync(new URL("../../frontend/src/rest-ritual.js", import.meta.url), "utf8");

function breakState(overrides = {}) {
  return {
    break: true,
    break_duration: 600,
    break_remaining: 600,
    pomodoro_duration: 3000,
    pomodoro_remaining: 3000,
    sessions_done: 1,
    reward_id: 1,
    ...overrides,
  };
}

test("cycle progress is honest from one through four and wraps only after completion", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 8].map(getCycleProgress),
    [0, 1, 2, 3, 4, 1, 4],
  );
});

test("rest phases use the canonical server duration without a fourth-session long-break inference", () => {
  assert.equal(getBreakDurationSeconds(breakState({ sessions_done: 4 })), 600);
  assert.equal(deriveRestRitualState(breakState()).phase, REST_PHASE.REVEAL);
  assert.equal(deriveRestRitualState(breakState({ break_remaining: 570 })).phase, REST_PHASE.REVEAL);
  assert.equal(deriveRestRitualState(breakState({ break_remaining: 569 })).phase, REST_PHASE.RESTORE);
  assert.equal(deriveRestRitualState(breakState({ break_remaining: 61 })).phase, REST_PHASE.RESTORE);
  assert.equal(deriveRestRitualState(breakState({ break_remaining: 60 })).phase, REST_PHASE.RETURN);
  assert.equal(deriveRestRitualState(breakState({ break: false, break_remaining: 0 })).phase, REST_PHASE.INACTIVE);
  assert.equal(deriveRestRitualState(breakState()).rewardId, 1);

  const durationSource = SOURCE.split("export function getBreakDurationSeconds", 2)[1].split(
    "export function deriveRestRitualState",
    1,
  )[0];
  assert.match(durationSource, /state\.break_duration/);
  assert.doesNotMatch(durationSource, /sessions_done|1500/);
});

test("numeric reward ids hydrate silently and reveal once per monotonic increase", () => {
  const tracker = createRewardRevealTracker();
  const observations = [4, 4, 5, 5, 3, 5, 6].map(value => tracker.observe(value));

  assert.deepEqual(observations.map(item => item.reveal), [false, false, true, false, false, false, true]);
  assert.deepEqual(observations.map(item => item.observedRewardId), [4, 4, 5, 5, 5, 5, 6]);
  assert.equal(tracker.getObservedRewardId(), 6);
  assert.equal(normalizeRewardId(0), 0);
  assert.equal(normalizeRewardId("6"), null);
  assert.equal(normalizeRewardId(6.5), null);
  assert.equal(normalizeRewardId(-1), null);

  tracker.reset();
  assert.equal(tracker.getObservedRewardId(), null);
  assert.equal(tracker.observe(1).reveal, false);
  assert.equal(tracker.observe(2).reveal, true);

  const invalidTracker = createRewardRevealTracker();
  assert.equal(invalidTracker.observe("1").reveal, false);
  assert.equal(invalidTracker.observe(1).reveal, false);
  assert.equal(invalidTracker.observe(2).reveal, true);
});

test("legacy is_break snapshots can still render while current break_remaining remains preferred", () => {
  const alias = deriveRestRitualState({
    is_break: true,
    break_duration: 600,
    pomodoro_remaining: 42,
    pomodoro_duration: 3000,
    sessions_done: 2,
  });
  assert.equal(alias.isBreak, true);
  assert.equal(alias.breakRemaining, 42);
  assert.equal(alias.phase, REST_PHASE.RETURN);
  assert.equal(alias.cycleProgress, 2);
});

test("recovery and next-intent choices are bounded, optional, and non-punitive", () => {
  assert.deepEqual(RECOVERY_CHOICES.map(choice => choice.label), ["눈 쉬기", "물 마시기", "짧게 호흡하기"]);
  assert.deepEqual(NEXT_INTENT_CHOICES.map(choice => choice.label), ["같은 일 계속", "다음 한 가지", "오늘 마침"]);
  assert.doesNotMatch(SOURCE, /send\(|fetch\(|WebSocket|currency|streak|reward_lock|required/);
  assert.doesNotMatch(SOURCE, /music|youtube/i);
});

test("stable DOM hooks expose reward progress without importing or mutating 3D code", () => {
  assert.match(SOURCE, /document\.body\.dataset\.restPhase/);
  assert.match(SOURCE, /document\.body\.dataset\.rewardProgress/);
  assert.match(SOURCE, /aethel:reward-progress/);
  assert.match(SOURCE, /completedSessions: model\.cycleProgress/);
  assert.match(SOURCE, /rewardId: model\.rewardId/);
  assert.doesNotMatch(SOURCE, /src\/3d|THREE|sceneController/);
});
