import { byId, setHiddenInteraction } from "./dom.js";
import { readNextIntent, storeNextIntent } from "./storage.js";

export const REST_PHASE = Object.freeze({
  INACTIVE: "inactive",
  REVEAL: "reveal",
  RESTORE: "restore",
  RETURN: "return",
});

export const RECOVERY_CHOICES = Object.freeze([
  Object.freeze({ value: "eyes", label: "눈 쉬기" }),
  Object.freeze({ value: "water", label: "물 마시기" }),
  Object.freeze({ value: "breathe", label: "짧게 호흡하기" }),
]);

export const NEXT_INTENT_CHOICES = Object.freeze([
  Object.freeze({ value: "continue", label: "같은 일 계속" }),
  Object.freeze({ value: "next", label: "다음 한 가지" }),
  Object.freeze({ value: "finish", label: "오늘 마침" }),
]);

const CYCLE_LENGTH = 4;
const STANDARD_BREAK_SECONDS = 600;
const REVEAL_SECONDS = 30;
const RETURN_SECONDS = 60;

function finiteInteger(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

export function normalizeRewardId(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function createRewardRevealTracker() {
  let observedRewardId = null;

  return {
    observe(value) {
      const rewardId = normalizeRewardId(value);
      const reveal = rewardId !== null && observedRewardId !== null && rewardId > observedRewardId;
      if (rewardId !== null && (observedRewardId === null || rewardId > observedRewardId)) {
        observedRewardId = rewardId;
      }
      return Object.freeze({ rewardId, observedRewardId, reveal });
    },
    getObservedRewardId: () => observedRewardId,
    reset() {
      observedRewardId = null;
    },
  };
}

export function getCycleProgress(sessionsDone) {
  const completed = finiteInteger(sessionsDone);
  if (completed === 0) return 0;
  return completed % CYCLE_LENGTH || CYCLE_LENGTH;
}

export function getBreakDurationSeconds(state = {}) {
  return Math.max(1, finiteInteger(state.break_duration, STANDARD_BREAK_SECONDS));
}

export function deriveRestRitualState(state = {}) {
  const isBreak = Boolean(state.break ?? state.is_break);
  const sessionsDone = finiteInteger(state.sessions_done);
  const cycleProgress = getCycleProgress(sessionsDone);
  const breakDuration = getBreakDurationSeconds(state);
  const fallbackRemaining = isBreak ? state.pomodoro_remaining : 0;
  const rawRemaining = Number.isFinite(state.break_remaining) ? state.break_remaining : fallbackRemaining;
  const breakRemaining = Math.min(breakDuration, finiteInteger(rawRemaining));
  const elapsed = Math.max(0, breakDuration - breakRemaining);
  const focusMinutes = Math.max(1, Math.round(finiteInteger(state.pomodoro_duration, 3000) / 60));
  const rewardId = normalizeRewardId(state.reward_id);

  let phase = REST_PHASE.INACTIVE;
  if (isBreak && breakRemaining <= RETURN_SECONDS) phase = REST_PHASE.RETURN;
  else if (isBreak && elapsed <= REVEAL_SECONDS) phase = REST_PHASE.REVEAL;
  else if (isBreak) phase = REST_PHASE.RESTORE;

  return Object.freeze({
    isBreak,
    phase,
    sessionsDone,
    cycleProgress,
    breakDuration,
    breakRemaining,
    focusMinutes,
    rewardId,
  });
}

function choiceLabel(choices, value) {
  return choices.find(choice => choice.value === value)?.label || "";
}

function phaseCopy(model) {
  if (model.phase === REST_PHASE.REVEAL) {
    return {
      eyebrow: "집중 완료",
      title: `${model.focusMinutes}분 집중을 완성했어요`,
      description: `오늘의 별자리 ${model.cycleProgress}/4. ${Math.round(model.breakDuration / 60)}분 휴식이 시작됐어요.`,
    };
  }
  if (model.phase === REST_PHASE.RETURN) {
    return {
      eyebrow: "천천히 귀환",
      title: "다음 집중을 가볍게 정해 둘까요?",
      description: "선택은 이 브라우저에만 남습니다. 아무것도 고르지 않아도 괜찮아요.",
    };
  }
  return {
    eyebrow: "회복 중",
    title: "화면을 잠시 떠나도 좋아요",
    description: "회복 하나를 골라도, 고르지 않아도 타이머는 그대로 흐릅니다.",
  };
}

export function createRestRitual() {
  const root = byId("rest-ritual");
  const title = byId("rest-title");
  const eyebrow = byId("rest-eyebrow");
  const description = byId("rest-description");
  const progress = byId("rest-cycle-progress");
  const recoveryGroup = byId("rest-recovery-options");
  const intentGroup = byId("rest-intent-options");
  const screenAway = byId("rest-screen-away");
  const live = byId("rest-live");
  const stars = [...root.querySelectorAll("[data-rest-star]")];
  const recoveryButtons = [...root.querySelectorAll("[data-rest-choice]")];
  const intentButtons = [...root.querySelectorAll("[data-next-intent]")];

  let selectedRecovery = null;
  let selectedIntent = readNextIntent();
  let previousPhase = REST_PHASE.INACTIVE;
  let previousProgress = -1;
  let previousRewardId = null;
  let wasBreak = false;
  let revealRewardId = null;
  let latestModel = deriveRestRitualState();
  const rewardTracker = createRewardRevealTracker();

  function updatePressed(buttons, attribute, selected) {
    for (const button of buttons) {
      const active = button.dataset[attribute] === selected;
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  function renderRecoverySelection() {
    updatePressed(recoveryButtons, "restChoice", selectedRecovery);
    root.dataset.screenAway = selectedRecovery ? "true" : "false";
    if (selectedRecovery) {
      const label = choiceLabel(RECOVERY_CHOICES, selectedRecovery);
      screenAway.textContent = `${label}를 골랐어요. 타이머는 계속 흐릅니다. 이제 화면을 잠시 떠나세요.`;
    } else {
      screenAway.textContent = "원한다면 하나만 고른 뒤, 화면을 보지 않고 쉬세요.";
    }
  }

  function renderIntentSelection() {
    updatePressed(intentButtons, "nextIntent", selectedIntent);
    root.dataset.nextIntent = selectedIntent || "none";
  }

  function focusBeforeHide(group, fallback) {
    if (!group.contains(document.activeElement)) return;
    const target = typeof fallback === "function" ? fallback() : fallback;
    target?.focus({ preventScroll: true });
  }

  function setGroupVisible(group, visible, focusFallback = null) {
    if (visible) {
      group.hidden = false;
      setHiddenInteraction(group, false);
      return;
    }
    focusBeforeHide(group, focusFallback);
    setHiddenInteraction(group, true);
    group.hidden = true;
  }

  function emitProgress(model, reveal) {
    window.dispatchEvent(new CustomEvent("aethel:reward-progress", {
      detail: {
        active: model.isBreak,
        phase: model.phase,
        completedSessions: model.cycleProgress,
        totalSessions: CYCLE_LENGTH,
        sessionsDone: model.sessionsDone,
        rewardId: model.rewardId,
        reveal,
      },
    }));
  }

  for (const button of recoveryButtons) {
    button.addEventListener("click", () => {
      const value = button.dataset.restChoice;
      selectedRecovery = selectedRecovery === value ? null : value;
      renderRecoverySelection();
      live.textContent = selectedRecovery
        ? `${choiceLabel(RECOVERY_CHOICES, selectedRecovery)}를 선택했습니다. 휴식 타이머는 계속 흐릅니다.`
        : "회복 선택을 지웠습니다. 휴식 타이머는 계속 흐릅니다.";
    });
  }

  for (const button of intentButtons) {
    button.addEventListener("click", () => {
      const value = button.dataset.nextIntent;
      selectedIntent = selectedIntent === value ? null : value;
      storeNextIntent(selectedIntent);
      renderIntentSelection();
      live.textContent = selectedIntent
        ? `${choiceLabel(NEXT_INTENT_CHOICES, selectedIntent)}으로 저장했습니다. 이 브라우저에만 남습니다.`
        : "다음 집중 선택을 지웠습니다. 아무것도 고르지 않아도 괜찮아요.";
    });
  }

  function update(state, { resetRewardBaseline = false } = {}) {
    const model = deriveRestRitualState(state);
    if (resetRewardBaseline) rewardTracker.reset();
    const rewardEvent = rewardTracker.observe(model.rewardId);
    const reveal = model.isBreak && rewardEvent.reveal;
    const enteredBreak = model.isBreak && !wasBreak;
    if (reveal) revealRewardId = model.rewardId;
    if (model.phase !== REST_PHASE.REVEAL) revealRewardId = null;
    const renderedPhase = model.phase === REST_PHASE.REVEAL && revealRewardId !== model.rewardId
      ? REST_PHASE.RESTORE
      : model.phase;
    const renderedModel = Object.freeze({ ...model, phase: renderedPhase, reveal });
    const phaseChanged = renderedPhase !== previousPhase;
    const progressChanged = model.cycleProgress !== previousProgress;
    const rewardChanged = model.rewardId !== previousRewardId;
    latestModel = renderedModel;

    document.body.dataset.restPhase = renderedPhase;
    document.body.dataset.rewardProgress = String(model.cycleProgress);
    root.dataset.phase = renderedPhase;
    root.dataset.progress = String(model.cycleProgress);

    if (!model.isBreak) {
      focusBeforeHide(root, () => state.focus ? byId("btn-pause-timer") : byId("focus-btn"));
      setHiddenInteraction(root, true);
      root.hidden = true;
      setGroupVisible(recoveryGroup, false, title);
      setGroupVisible(intentGroup, false, title);
    } else {
      if (enteredBreak) selectedRecovery = null;
      root.hidden = false;
      setHiddenInteraction(root, false);
      const copy = phaseCopy(renderedModel);
      eyebrow.textContent = copy.eyebrow;
      title.textContent = copy.title;
      description.textContent = copy.description;
      progress.textContent = `${model.cycleProgress} / ${CYCLE_LENGTH}`;
      progress.setAttribute(
        "aria-label",
        `현재 집중 주기 ${model.cycleProgress}/${CYCLE_LENGTH}, 전체 완료 ${model.sessionsDone}회`,
      );
      stars.forEach((star, index) => star.classList.toggle("is-earned", index < model.cycleProgress));
      if (renderedPhase === REST_PHASE.RETURN) {
        setGroupVisible(intentGroup, true);
        setGroupVisible(recoveryGroup, false, () => intentButtons[0] || title);
      } else {
        setGroupVisible(recoveryGroup, true);
        setGroupVisible(intentGroup, false, () => recoveryButtons[0] || title);
      }
      renderRecoverySelection();
      renderIntentSelection();

      if (reveal) {
        live.textContent = `집중을 완료했습니다. 현재 주기 ${model.cycleProgress}/${CYCLE_LENGTH}. 휴식이 시작되었습니다.`;
      } else if (phaseChanged && renderedPhase === REST_PHASE.RETURN) {
        live.textContent = "휴식이 1분 남았습니다. 원한다면 다음 집중 방향을 선택할 수 있습니다.";
      }
    }

    if (phaseChanged || progressChanged || rewardChanged) emitProgress(renderedModel, reveal);
    previousPhase = renderedPhase;
    previousProgress = model.cycleProgress;
    previousRewardId = model.rewardId;
    wasBreak = model.isBreak;
    return renderedModel;
  }

  setHiddenInteraction(root, true);
  setGroupVisible(recoveryGroup, false);
  setGroupVisible(intentGroup, false);
  renderRecoverySelection();
  renderIntentSelection();

  return { update, getState: () => latestModel };
}
