import { byId, setHiddenInteraction } from "./dom.js";

const MAX_TASKS = 8;


function nextTaskId(tasks) {
  const used = new Set(tasks.map(task => task.id));
  for (let index = 1; index <= 999; index += 1) {
    const id = `task_${String(index).padStart(3, "0")}`;
    if (!used.has(id)) return id;
  }
  return `task_${Date.now().toString(36)}`;
}


function taskById(tasks, id) {
  return tasks.find(task => task.id === id) || null;
}


export function createRoomIntentController({ getState, send }) {
  const panel = byId("intent-panel");
  const toggle = byId("intent-toggle");
  const body = byId("intent-body");
  const offNote = byId("intent-off-note");
  const goalInput = byId("intent-goal-input");
  const goalText = byId("intent-goal-text");
  const goalSave = byId("intent-goal-save");
  const taskInput = byId("intent-task-input");
  const taskAdd = byId("intent-task-add");
  const taskList = byId("intent-task-list");
  const activeTask = byId("intent-active-task");
  const clearCompleted = byId("intent-clear-completed");
  const status = byId("intent-status");
  let lastActiveTaskId = null;

  function currentIntent() {
    return getState()?.intent || { enabled: true, goal: "", tasks: [], active_task_id: null };
  }

  function setStatus(message) {
    status.textContent = message;
  }

  function saveGoal() {
    send({ type: "intent_set_goal", goal: goalInput.value.trim() });
    setStatus("방 목표를 저장했습니다.");
  }

  function setEnabled(nextEnabled) {
    send({ type: "intent_set_enabled", enabled: nextEnabled });
    setStatus(nextEnabled ? "방 목표를 켰습니다." : "방 목표를 껐습니다.");
  }

  function addTask() {
    const text = taskInput.value.trim();
    const intent = currentIntent();
    if (!text) {
      taskInput.focus();
      return;
    }
    if (intent.tasks.length >= MAX_TASKS) {
      setStatus("작업은 8개까지 추가할 수 있습니다.");
      return;
    }
    send({ type: "intent_add_task", id: nextTaskId(intent.tasks), text });
    taskInput.value = "";
    setStatus("작업을 추가했습니다.");
  }

  function renderIntent(intent) {
    const enabled = intent.enabled !== false;
    const active = taskById(intent.tasks, intent.active_task_id);
    panel.dataset.intentEnabled = String(enabled);
    toggle.textContent = enabled ? "끄기" : "켜기";
    toggle.setAttribute("aria-expanded", enabled ? "true" : "false");
    offNote.hidden = enabled;
    body.hidden = !enabled;
    setHiddenInteraction(body, !enabled);
    goalText.textContent = intent.goal || "목표를 정해 주세요.";
    if (document.activeElement !== goalInput) goalInput.value = intent.goal;
    activeTask.textContent = active ? `선택한 작업 · ${active.text}` : "선택한 작업 없음";
    if (intent.active_task_id !== lastActiveTaskId) {
      setStatus(active ? "작업을 선택했습니다." : "선택한 작업을 해제했습니다.");
      lastActiveTaskId = intent.active_task_id;
    }

    taskList.replaceChildren(...intent.tasks.map(task => {
      const item = document.createElement("li");
      item.className = "intent-task-item";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "intent-task-action";
      toggle.textContent = task.done ? "해제" : "완료";
      toggle.addEventListener("click", () => {
        send({ type: "intent_toggle_task", id: task.id, done: !task.done });
        setStatus(task.done ? "작업 완료를 해제했습니다." : "작업을 완료했습니다.");
      });

      const select = document.createElement("button");
      select.type = "button";
      select.className = "intent-task-select";
      select.dataset.intentTaskId = task.id;
      select.dataset.active = String(intent.active_task_id === task.id);
      select.dataset.done = String(task.done);
      select.textContent = task.text;
      select.setAttribute("aria-pressed", intent.active_task_id === task.id ? "true" : "false");
      select.addEventListener("click", () => {
        send({ type: "intent_select_task", id: task.id });
        setStatus("작업을 선택했습니다.");
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "intent-task-action";
      remove.textContent = "삭제";
      remove.addEventListener("click", () => {
        send({ type: "intent_delete_task", id: task.id });
        setStatus("작업을 삭제했습니다.");
      });

      item.replaceChildren(toggle, select, remove);
      return item;
    }));
  }

  goalSave.addEventListener("click", saveGoal);
  toggle.addEventListener("click", () => {
    setEnabled(currentIntent().enabled === false);
  });
  goalInput.addEventListener("keydown", event => {
    if (event.key === "Enter") saveGoal();
  });
  taskAdd.addEventListener("click", addTask);
  taskInput.addEventListener("keydown", event => {
    if (event.key === "Enter") addTask();
  });
  clearCompleted.addEventListener("click", () => {
    send({ type: "intent_clear_completed" });
    setStatus("완료한 작업을 정리했습니다.");
  });

  return { renderIntent };
}
