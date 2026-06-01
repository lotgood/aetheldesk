import os
from typing import Final


REDIS_URL: Final[str] = os.getenv("REDIS_URL", "redis://redis:6379/0")
ROOM_TTL_SECONDS: Final[int] = int(os.getenv("ROOM_TTL_SECONDS", "300"))
ROOM_TICK_LOCK_SECONDS: Final[int] = int(os.getenv("ROOM_TICK_LOCK_SECONDS", "2"))
ENVIRONMENT: Final[str] = os.getenv("AETHELDESK_ENV", "production").strip().lower()

# Only honor X-Forwarded-For for client identity (rate limiting) when running
# behind a trusted reverse proxy. Off by default so a directly exposed app
# cannot have its PIN brute-force protection bypassed via a spoofed header.
TRUST_PROXY: Final[bool] = os.getenv("AETHELDESK_TRUST_PROXY", "").strip().lower() in {"1", "true", "yes", "on"}

TEST_SECRET_KEY: Final[str] = "test-only-secret"


def is_test_mode() -> bool:
    if os.getenv("PYTEST_CURRENT_TEST"):
        return True
    return ENVIRONMENT in {"test", "pytest"}


def get_secret_key() -> str:
    secret = os.getenv("AETHELDESK_SECRET_KEY")
    if secret:
        return secret
    if is_test_mode():
        return TEST_SECRET_KEY
    raise RuntimeError(
        "AETHELDESK_SECRET_KEY is required outside pytest/test mode "
        "(set it in production/docker environments)."
    )


def get_worker_identity() -> str:
    explicit = os.getenv("AETHELDESK_WORKER_ID")
    if explicit:
        return explicit
    hostname = os.getenv("HOSTNAME", "worker")
    return f"{hostname}:{os.getpid()}"
