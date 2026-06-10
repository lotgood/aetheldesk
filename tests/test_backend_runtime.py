from backend import main as backend_main
from backend import runtime as backend_runtime


def test_runtime_module_feeds_main_compatibility_exports():
    assert backend_runtime.get_runtime() is backend_main
    assert backend_main.rooms is backend_runtime.rooms
    assert backend_main.connections is backend_runtime.connections
    assert backend_main.event_subscription_tasks is backend_runtime.event_subscription_tasks
    assert backend_main.local_pin_hashes is backend_runtime.local_pin_hashes
    assert backend_main.local_token_hashes is backend_runtime.local_token_hashes
    assert backend_main.local_room_instance_ids is backend_runtime.local_room_instance_ids
    assert backend_main.worker_id == backend_runtime.worker_id
    assert backend_main.config is backend_runtime.config
