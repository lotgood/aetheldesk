from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:
    from backend.client_messages import (
        CheckinAddCommand,
        AmbienceSetEnabledCommand,
        AmbienceSetLayerCommand,
        ClientCommand,
        IntentSetEnabledCommand,
        IntentSetGoalCommand,
        IntentTaskIdCommand,
        IntentTaskTextCommand,
        IntentToggleTaskCommand,
        SceneSelectCommand,
    )
    from backend.state import BackendState


MAX_TASKS = 8
MAX_CHECKINS = 12


def apply_room_feature_command(state: "BackendState", command: "ClientCommand") -> bool:
    t = command["type"]
    if t == "intent_set_goal":
        intent_set_goal = cast("IntentSetGoalCommand", command)
        state["intent"]["goal"] = intent_set_goal["goal"]
    elif t == "intent_set_enabled":
        intent_set_enabled = cast("IntentSetEnabledCommand", command)
        state["intent"]["enabled"] = intent_set_enabled["enabled"]
    elif t == "intent_add_task":
        intent_task = cast("IntentTaskTextCommand", command)
        task_id = intent_task["id"]
        tasks = state["intent"]["tasks"]
        if len(tasks) < MAX_TASKS and all(task["id"] != task_id for task in tasks):
            tasks.append({"id": task_id, "text": intent_task["text"], "done": False})
    elif t == "intent_update_task":
        intent_task = cast("IntentTaskTextCommand", command)
        for task in state["intent"]["tasks"]:
            if task["id"] == intent_task["id"]:
                task["text"] = intent_task["text"]
                break
    elif t == "intent_toggle_task":
        intent_toggle = cast("IntentToggleTaskCommand", command)
        for task in state["intent"]["tasks"]:
            if task["id"] == intent_toggle["id"]:
                if not task["done"] and intent_toggle["done"]:
                    state["metrics"]["tasks_completed"] += 1
                task["done"] = intent_toggle["done"]
                break
    elif t == "intent_select_task":
        intent_task_id = cast("IntentTaskIdCommand", command)
        task_id = intent_task_id["id"]
        task_ids = {task["id"] for task in state["intent"]["tasks"]}
        state["intent"]["active_task_id"] = task_id if task_id in task_ids else None
    elif t == "intent_delete_task":
        intent_task_id = cast("IntentTaskIdCommand", command)
        task_id = intent_task_id["id"]
        state["intent"]["tasks"] = [task for task in state["intent"]["tasks"] if task["id"] != task_id]
        if state["intent"]["active_task_id"] == task_id:
            state["intent"]["active_task_id"] = None
    elif t == "intent_clear_completed":
        state["intent"]["tasks"] = [task for task in state["intent"]["tasks"] if not task["done"]]
        task_ids = {task["id"] for task in state["intent"]["tasks"]}
        if state["intent"]["active_task_id"] not in task_ids:
            state["intent"]["active_task_id"] = None
    elif t == "checkin_add":
        checkin = cast("CheckinAddCommand", command)
        if all(item["id"] != checkin["id"] for item in state["checkins"]):
            state["checkins"].append({"id": checkin["id"], "kind": checkin["kind"], "text": checkin["text"]})
            state["checkins"] = state["checkins"][-MAX_CHECKINS:]
    elif t == "checkin_clear":
        state["checkins"] = []
    elif t == "scene_select":
        scene = cast("SceneSelectCommand", command)
        state["scene"] = scene["scene"]
    elif t == "ambience_set_enabled":
        ambience = cast("AmbienceSetEnabledCommand", command)
        state["ambience"]["enabled"] = ambience["enabled"]
    elif t == "ambience_set_layer":
        ambience_layer = cast("AmbienceSetLayerCommand", command)
        state["ambience"]["layers"][ambience_layer["layer"]] = ambience_layer["volume"]
    else:
        return False
    return True
