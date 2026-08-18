from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.application.vehicle_aggregate import (
    CompiledAggregate,
    GovernedSemanticRegistry,
    GovernedVehicleAggregateCompiler,
    GovernedVehicleAggregateService,
    VehicleAggregateError,
    VehicleAggregateRequest,
)
from app.domain.identity import Principal
from app.infrastructure.vehicle_aggregate import LiveGovernedClickHouseAggregateExecutor


def request(
    *,
    metric_id: str = "vehicle.count.short_rental_order",
    month: str = "2026-06",
    groups: list[str] | None = None,
    filters: list[dict[str, str]] | None = None,
) -> VehicleAggregateRequest:
    return VehicleAggregateRequest.model_validate(
        {
            "metricId": metric_id,
            "time": {"kind": "business_month", "value": month},
            "groupByFieldIds": groups or [],
            "filters": filters or [],
        }
    )


def test_compiler_uses_registry_binding_and_real_source_month_format(
    registry: GovernedSemanticRegistry,
) -> None:
    compiled = GovernedVehicleAggregateCompiler(registry).compile(request(), ("demo-east",))

    assert compiled.source_id == "vehicle.mount.short_rental_orders_demo"
    assert compiled.identity_field_id == "short_rental.order_id"
    assert "FROM vehicle_demo.short_rental_orders" in compiled.sql
    assert "business_month = {businessMonth:String}" in compiled.sql
    assert "organization_id IN (SELECT organizationId FROM scopeOrganizations)" in compiled.sql
    assert "uniqExactIf(trimBoth(ifNull(order_id, ''))" in compiled.sql
    assert "LIMIT" not in compiled.sql.upper()
    assert compiled.parameters == {"businessMonth": "2026年06月"}


def test_supplier_grouping_is_bounded_and_bound_by_semantic_id(
    registry: GovernedSemanticRegistry,
) -> None:
    compiled = GovernedVehicleAggregateCompiler(registry).compile(
        request(groups=["vehicle.dimension.supplier"]),
        ("demo-hq",),
    )

    assert "supplier_name AS group_0" in compiled.sql
    assert "GROUP BY group_0" in compiled.sql
    assert "LIMIT 201" in compiled.sql
    assert compiled.group_result_limit == 200


def test_browser_cannot_override_or_group_organization(
    registry: GovernedSemanticRegistry,
) -> None:
    compiler = GovernedVehicleAggregateCompiler(registry)
    with pytest.raises(VehicleAggregateError) as filtered:
        compiler.compile(
            request(filters=[{
                "fieldId": "vehicle.dimension.organization",
                "operator": "eq",
                "value": "attacker-selected-scope",
            }]),
            ("demo-hq",),
        )
    assert filtered.value.code == "ORGANIZATION_SCOPE_OVERRIDE"

    with pytest.raises(VehicleAggregateError) as grouped:
        compiler.compile(
            request(groups=["vehicle.dimension.organization"]),
            ("demo-hq",),
        )
    assert grouped.value.code == "ORGANIZATION_GROUPING_FORBIDDEN"


@pytest.mark.asyncio
async def test_service_resolves_principal_scope_and_executes_one_pushdown_query(
    registry: GovernedSemanticRegistry,
    principal: Principal,
) -> None:
    class Resolver:
        roots: tuple[str, ...] | None = None

        async def resolve(self, roots: tuple[str, ...]) -> tuple[str, ...]:
            self.roots = roots
            return ("demo-hq", "demo-east", "demo-west")

    class Executor:
        calls: list[CompiledAggregate]

        def __init__(self) -> None:
            self.calls = []

        async def execute(self, compiled: CompiledAggregate) -> list[dict[str, Any]]:
            self.calls.append(compiled)
            return [{"value": "11"}]

    resolver = Resolver()
    executor = Executor()
    result = await GovernedVehicleAggregateService(
        registry,
        executor,
        scope_resolver=resolver,
    ).aggregate(request(), principal)

    assert resolver.roots == ("principal-root",)
    assert len(executor.calls) == 1
    assert executor.calls[0].organization_scope == ("demo-east", "demo-hq", "demo-west")
    assert "LIMIT" not in executor.calls[0].sql.upper()
    assert result.value == 11
    assert result.completeness == "complete"
    assert result.data_quality.organization_attribution.status == "measured"
    payload = result.model_dump_json(by_alias=True)
    assert "principal-root" not in payload
    assert "demo-east" not in payload


@pytest.mark.asyncio
async def test_clickhouse_executor_uses_external_scope_table_without_pagination(
    monkeypatch: pytest.MonkeyPatch,
    registry: GovernedSemanticRegistry,
) -> None:
    captured: dict[str, bytes] = {}

    def handler(http_request: httpx.Request) -> httpx.Response:
        captured["body"] = http_request.content
        return httpx.Response(200, json={"data": [{"value": "11"}]})

    transport = httpx.MockTransport(handler)
    async_client = httpx.AsyncClient
    monkeypatch.setattr(
        "app.infrastructure.vehicle_aggregate.httpx.AsyncClient",
        lambda **kwargs: async_client(transport=transport, **kwargs),
    )
    compiled = GovernedVehicleAggregateCompiler(registry).compile(
        request(),
        ("demo-hq", "demo-east"),
    )
    rows = await LiveGovernedClickHouseAggregateExecutor(
        "http://clickhouse.test",
        "default",
        "",
    ).execute(compiled)

    assert rows == [{"value": "11"}]
    assert b'name="param_businessMonth"' in captured["body"]
    assert b"scopeOrganizations" in captured["body"]
    assert b"demo-hq" in captured["body"]
    assert b"LIMIT" not in captured["body"].upper()


@pytest.mark.asyncio
async def test_empty_aggregate_result_is_not_fabricated_as_zero(
    registry: GovernedSemanticRegistry,
    principal: Principal,
) -> None:
    class Executor:
        async def execute(self, compiled: CompiledAggregate) -> list[dict[str, Any]]:
            del compiled
            return []

    with pytest.raises(VehicleAggregateError) as raised:
        await GovernedVehicleAggregateService(registry, Executor()).aggregate(request(), principal)
    assert raised.value.code == "RESULT_SCHEMA_MISMATCH"
