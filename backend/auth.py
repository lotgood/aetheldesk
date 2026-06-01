import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass

try:
    from backend import config
except ModuleNotFoundError:
    import config


PIN_HASH_ITERATIONS = 200_000
PIN_SALT_BYTES = 16
TOKEN_BYTES = 32
PIN_ATTEMPT_WINDOW_SECONDS = 300
PIN_MAX_ATTEMPTS = 5
PIN_BLOCK_SECONDS = 600


@dataclass(frozen=True)
class PinRatePolicy:
    attempt_window_seconds: int = PIN_ATTEMPT_WINDOW_SECONDS
    max_attempts: int = PIN_MAX_ATTEMPTS
    block_seconds: int = PIN_BLOCK_SECONDS


def hash_pin(pin: str) -> str:
    salt = secrets.token_bytes(PIN_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, PIN_HASH_ITERATIONS)
    salt_b64 = base64.urlsafe_b64encode(salt).decode("ascii")
    digest_b64 = base64.urlsafe_b64encode(digest).decode("ascii")
    return f"pbkdf2_sha256${PIN_HASH_ITERATIONS}${salt_b64}${digest_b64}"


def verify_pin(pin: str, encoded_hash: str) -> bool:
    try:
        algorithm, iterations_s, salt_b64, digest_b64 = encoded_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(iterations_s)
        salt = base64.urlsafe_b64decode(salt_b64.encode("ascii"))
        expected = base64.urlsafe_b64decode(digest_b64.encode("ascii"))
    except (ValueError, TypeError):
        return False

    candidate = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(candidate, expected)


def create_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    key = config.get_secret_key().encode("utf-8")
    return hmac.new(key, token.encode("utf-8"), hashlib.sha256).hexdigest()


def failure_body() -> dict[str, str]:
    return {"detail": "authentication failed"}
