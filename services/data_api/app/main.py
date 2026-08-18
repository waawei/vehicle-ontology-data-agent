from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.application.vehicle_aggregate import (
    GovernedSemanticRegistry,
    GovernedVehicleAggregateService,
    VehicleAggregateError,
    VehicleAggregateRequest,
    VehicleAggregateResponse,
)
from app.application.vehicle_compare import (
    GovernedVehicleCompareService,
    VehicleCompareRequest,
    VehicleCompareResponse,
)
from app.domain.identity import Principal
from app.identity import (
    CSRF_COOKIE,
    DemoSessionManager,
    LoginRequest,
    PublicPrincipal,
    RegisterRequest,
    current_principal,
    public_principal,
)
from app.infrastructure.vehicle_aggregate import LiveGovernedClickHouseAggregateExecutor
from app.settings import Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    active = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        registry = GovernedSemanticRegistry.from_files(active.semantic_root)
        aggregate = GovernedVehicleAggregateService(
            registry,
            LiveGovernedClickHouseAggregateExecutor(
                active.clickhouse_url,
                active.clickhouse_user,
                active.clickhouse_password,
                timeout_seconds=active.clickhouse_timeout_seconds,
            ),
            scope_resolver=DemoOrganizationScopeResolver(),
        )
        application.state.sessions = DemoSessionManager(active.session_secret)
        application.state.aggregate = aggregate
        application.state.compare = GovernedVehicleCompareService(aggregate)
        application.state.settings = active
        yield

    application = FastAPI(
        title="Vehicle Governed Data API",
        version=__version__,
        lifespan=lifespan,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(active.allowed_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-CSRF-Token"],
    )

    @application.exception_handler(VehicleAggregateError)
    async def vehicle_error(_request: Request, error: VehicleAggregateError):
        from fastapi.responses import JSONResponse

        return JSONResponse(
            status_code=error.status_code,
            content={"error": {"code": error.code, "message": error.message, "details": error.details}},
        )

    @application.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/auth/me", response_model=PublicPrincipal, response_model_by_alias=True)
    async def me(request: Request, response: Response) -> PublicPrincipal:
        token = request.cookies.get("vehicle_session")
        principal = request.app.state.sessions.authenticate(token)
        if principal is None and active.demo_auto_login:
            principal = request.app.state.sessions.issue(response)
        if principal is None:
            raise HTTPException(status_code=401, detail="Authentication is required")
        return public_principal(principal)

    @application.post("/auth/login", response_model=PublicPrincipal, response_model_by_alias=True)
    async def login(payload: LoginRequest, response: Response, request: Request) -> PublicPrincipal:
        return public_principal(request.app.state.sessions.login(payload.email, payload.password, response))

    @application.post("/auth/register", response_model=PublicPrincipal, response_model_by_alias=True)
    async def register(payload: RegisterRequest, response: Response, request: Request) -> PublicPrincipal:
        del payload
        if not active.demo_auto_login:
            raise HTTPException(status_code=403, detail="Registration is disabled")
        return public_principal(request.app.state.sessions.issue(response))

    @application.post("/auth/logout", status_code=204)
    async def logout(response: Response) -> None:
        response.delete_cookie("vehicle_session", path="/")
        response.delete_cookie(CSRF_COOKIE, path="/")

    @application.post(
        "/tools/vehicle.aggregate",
        response_model=VehicleAggregateResponse,
        response_model_by_alias=True,
    )
    async def aggregate(
        payload: VehicleAggregateRequest,
        principal: Annotated[Principal, Depends(current_principal)],
        request: Request,
    ) -> VehicleAggregateResponse:
        return await request.app.state.aggregate.aggregate(payload, principal)

    @application.post(
        "/tools/vehicle.compare",
        response_model=VehicleCompareResponse,
        response_model_by_alias=True,
    )
    async def compare(
        payload: VehicleCompareRequest,
        principal: Annotated[Principal, Depends(current_principal)],
        request: Request,
    ) -> VehicleCompareResponse:
        return await request.app.state.compare.compare(payload, principal)

    return application


class DemoOrganizationScopeResolver:
    async def resolve(self, authorization_roots: tuple[str, ...]) -> tuple[str, ...]:
        if authorization_roots != ("demo-hq",):
            raise VehicleAggregateError("ORGANIZATION_SCOPE_UNAVAILABLE", "Demo scope is unavailable", 403)
        return ("demo-hq", "demo-east", "demo-west")


app = create_app()
