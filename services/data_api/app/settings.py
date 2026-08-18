from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    semantic_root: Path
    clickhouse_url: str
    clickhouse_user: str
    clickhouse_password: str
    clickhouse_timeout_seconds: float
    session_secret: str
    demo_auto_login: bool
    allowed_origins: tuple[str, ...]

    @classmethod
    def from_env(cls) -> Settings:
        repository_root = Path(__file__).resolve().parents[3]
        semantic_root = Path(
            os.getenv("VEHICLE_SEMANTIC_ROOT", str(repository_root / "semantic"))
        ).resolve()
        return cls(
            host=os.getenv("DATA_API_HOST", "127.0.0.1"),
            port=_integer("DATA_API_PORT", 8090, 1024, 65535),
            semantic_root=semantic_root,
            clickhouse_url=os.getenv("CLICKHOUSE_URL", "http://127.0.0.1:8123").rstrip("/"),
            clickhouse_user=os.getenv("CLICKHOUSE_USER", "default"),
            clickhouse_password=os.getenv("CLICKHOUSE_PASSWORD", ""),
            clickhouse_timeout_seconds=_float("CLICKHOUSE_TIMEOUT_SECONDS", 20.0, 1.0, 120.0),
            session_secret=os.getenv("SESSION_SECRET", "local-demo-session-secret-change-me"),
            demo_auto_login=_boolean("DEMO_AUTO_LOGIN", True),
            allowed_origins=tuple(
                value.strip().rstrip("/")
                for value in os.getenv(
                    "DATA_API_CORS_ORIGINS",
                    "http://127.0.0.1:5180,http://localhost:5180",
                ).split(",")
                if value.strip()
            ),
        )


def _integer(name: str, fallback: int, minimum: int, maximum: int) -> int:
    value = int(os.getenv(name, str(fallback)))
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _float(name: str, fallback: float, minimum: float, maximum: float) -> float:
    value = float(os.getenv(name, str(fallback)))
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _boolean(name: str, fallback: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return fallback
    return value.strip().lower() in {"1", "true", "yes", "on"}
