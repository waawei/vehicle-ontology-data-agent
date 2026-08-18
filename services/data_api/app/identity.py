from __future__ import annotations

import hashlib
import hmac
import secrets
from base64 import urlsafe_b64decode, urlsafe_b64encode
from dataclasses import dataclass
from typing import Annotated

from fastapi import Cookie, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.domain.identity import Principal

SESSION_COOKIE = "vehicle_session"
CSRF_COOKIE = "r6_csrf"


class PublicPrincipal(BaseModel):
    model_config = ConfigDict(alias_generator=lambda value: value.split("_")[0] + "".join(
        part[:1].upper() + part[1:] for part in value.split("_")[1:]
    ), populate_by_name=True)

    id: str
    email: str
    display_name: str
    permissions: list[str]
    data_scope: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=256)
    display_name: str = Field(alias="displayName", min_length=1, max_length=160)
    tenant_name: str = Field(alias="tenantName", min_length=1, max_length=160)


@dataclass(frozen=True)
class DemoIdentity:
    principal: Principal
    email: str


class DemoSessionManager:
    """Local-only identity adapter; production deployments replace this boundary."""

    def __init__(self, secret: str) -> None:
        if len(secret) < 16:
            raise ValueError("SESSION_SECRET must contain at least 16 characters")
        self._secret = secret.encode("utf-8")
        self._identity = DemoIdentity(
            principal=Principal(
                user_id="demo-user",
                tenant_id="demo-tenant",
                email="demo@example.test",
                display_name="Demo Analyst",
                session_id="demo-session",
                permissions=frozenset({"vehicle.aggregate", "vehicle.compare"}),
                organization_ids=frozenset({"demo-hq"}),
                data_scope="organization",
            ),
            email="demo@example.test",
        )

    def issue(self, response: Response) -> Principal:
        token = self._signed_token(self._identity.principal.user_id)
        csrf = secrets.token_urlsafe(24)
        response.set_cookie(
            SESSION_COOKIE,
            token,
            httponly=True,
            samesite="strict",
            secure=False,
            path="/",
        )
        response.set_cookie(
            CSRF_COOKIE,
            csrf,
            httponly=False,
            samesite="strict",
            secure=False,
            path="/",
        )
        return self._identity.principal

    def authenticate(self, token: str | None) -> Principal | None:
        if not token:
            return None
        try:
            encoded, signature = token.split(".", 1)
            payload = urlsafe_b64decode(encoded + "==").decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None
        expected = hmac.new(self._secret, encoded.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature) or payload != self._identity.principal.user_id:
            return None
        return self._identity.principal

    def login(self, email: str, password: str, response: Response) -> Principal:
        if email.lower() != self._identity.email or password != "demo-password":
            raise HTTPException(status_code=401, detail="Invalid demo credentials")
        return self.issue(response)

    def _signed_token(self, principal_id: str) -> str:
        encoded = urlsafe_b64encode(principal_id.encode("utf-8")).decode("ascii").rstrip("=")
        signature = hmac.new(self._secret, encoded.encode("ascii"), hashlib.sha256).hexdigest()
        return f"{encoded}.{signature}"


def public_principal(principal: Principal) -> PublicPrincipal:
    return PublicPrincipal(
        id=principal.user_id,
        email=principal.email,
        display_name=principal.display_name,
        permissions=sorted(principal.permissions),
        data_scope=principal.data_scope,
    )


def session_manager(request: Request) -> DemoSessionManager:
    return request.app.state.sessions


async def current_principal(
    manager: Annotated[DemoSessionManager, Depends(session_manager)],
    token: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
) -> Principal:
    principal = manager.authenticate(token)
    if principal is None:
        raise HTTPException(status_code=401, detail="Authentication is required")
    return principal
