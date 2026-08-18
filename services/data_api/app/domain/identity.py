from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


class IdentityError(Exception):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


@dataclass(frozen=True)
class Principal:
    user_id: str
    tenant_id: str
    email: str
    display_name: str
    session_id: str
    permissions: frozenset[str]
    organization_ids: frozenset[str]
    data_scope: str


@dataclass(frozen=True)
class IssuedSession:
    token: str
    csrf: str
    expires_at: datetime
    principal: Principal
