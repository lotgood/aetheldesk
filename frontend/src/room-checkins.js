import { byId } from "./dom.js";

const CHECKIN_LABELS = {
  ready: "준비",
  progress: "진행 중",
  done: "완료",
};


function nextCheckinId(checkins) {
  const used = new Set(checkins.map(checkin => checkin.id));
  for (let index = 1; index <= 999; index += 1) {
    const id = `check_${String(index).padStart(3, "0")}`;
    if (!used.has(id)) return id;
  }
  return `check_${Date.now().toString(36)}`;
}


function activeTask(intent) {
  return intent.tasks.find(task => task.id === intent.active_task_id) || null;
}


function focusBriefing(intent) {
  const task = activeTask(intent);
  const parts = [];
  if (intent.goal) parts.push(`목표: ${intent.goal}`);
  if (task) parts.push(`작업: ${task.text}`);
  return parts.length ? `이번 집중 · ${parts.join(" · ")}` : "집중을 시작했습니다.";
}


function celebrationText(state) {
  const doneCount = state.intent.tasks.filter(task => task.done).length;
  const latest = state.checkins[state.checkins.length - 1];
  const pieces = [`잘했어요. 완료한 작업 ${doneCount}개`];
  if (latest) pieces.push(`최근 체크인: ${CHECKIN_LABELS[latest.kind]}`);
  return pieces.join(" · ");
}


export function createRoomCheckinsController({ getState, send }) {
  const textInput = byId("checkin-text-input");
  const list = byId("checkin-list");
  const status = byId("checkin-status");
  const briefing = byId("checkin-briefing");
  const celebration = byId("celebration-prompt");

  function currentCheckins() {
    return getState()?.checkins || [];
  }

  function setStatus(message) {
    status.textContent = message;
  }

  function addCheckin(kind) {
    const text = textInput.value.trim();
    send({ type: "checkin_add", id: nextCheckinId(currentCheckins()), kind, text });
    textInput.value = "";
    setStatus(`${CHECKIN_LABELS[kind]} 체크인을 남겼습니다.`);
  }

  function renderList(checkins) {
    list.replaceChildren(...checkins.map(checkin => {
      const item = document.createElement("li");
      item.className = "checkin-item";

      const label = document.createElement("span");
      label.className = "checkin-kind";
      label.textContent = CHECKIN_LABELS[checkin.kind];

      const text = document.createElement("span");
      text.className = "checkin-text";
      text.textContent = checkin.text || "메모 없음";

      item.replaceChildren(label, text);
      return item;
    }));
  }

  function renderCelebration(state, previousState) {
    const enteredBreak = !previousState?.break && state.break;
    if (state.break) {
      celebration.hidden = false;
      celebration.textContent = celebrationText(state);
      if (enteredBreak) setStatus(celebration.textContent);
      return;
    }
    celebration.hidden = true;
    celebration.textContent = "";
  }

  function renderCheckins(state, previousState) {
    renderList(state.checkins);
    if (state.focus) {
      briefing.textContent = focusBriefing(state.intent);
      if (!previousState?.focus) setStatus(briefing.textContent);
    } else if (!state.break) {
      briefing.textContent = "준비, 진행 중, 완료를 남겨 주세요.";
    }
    renderCelebration(state, previousState);
  }

  document.querySelectorAll("[data-checkin-kind]").forEach(button => {
    button.addEventListener("click", () => addCheckin(button.dataset.checkinKind));
  });
  byId("checkin-clear").addEventListener("click", () => {
    send({ type: "checkin_clear" });
    setStatus("체크인을 비웠습니다.");
  });

  return { renderCheckins };
}
