from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.application.vehicle_aggregate import (
    GovernedSemanticRegistry,
    GovernedVehicleAggregateService,
    VehicleAggregateRequest,
)
from app.domain.identity import Principal
from app.infrastructure.vehicle_aggregate import LiveGovernedClickHouseAggregateExecutor

CLICKHOUSE_URL = os.getenv("CLICKHOUSE_INTEGRATION_URL")
SEMANTIC_ROOT = Path(__file__).resolve().parents[3] / "semantic"
pytestmark = pytest.mark.skipif(
    not CLICKHOUSE_URL,
    reason="CLICKHOUSE_INTEGRATION_URL is not configured",
)


class DemoScopeResolver:
    async def resolve(self, roots: tuple[str, ...]) -> tuple[str, ...]:
        assert roots == ("demo-hq",)
        return ("demo-hq", "demo-east", "demo-west")


def _request(month: str, *, grouped: bool = False) -> VehicleAggregateRequest:
    return VehicleAggregateRequest.model_validate(
        {
            "metricId": "vehicle.count.short_rental_order",
            "time": {"kind": "business_month", "value": month},
            "groupByFieldIds": ["vehicle.dimension.supplier"] if grouped else [],
            "filters": [],
        }
    )


def _principal() -> Principal:
    return Principal(
        user_id="integration-user",
        tenant_id="demo-tenant",
        email="integration@example.test",
        display_name="Integration User",
        session_id="integration-session",
        permissions=frozenset({"vehicle.aggregate"}),
        organization_ids=frozenset({"demo-hq"}),
        data_scope="organization",
    )


@pytest.mark.asyncio
async def test_clickhouse_distinct_month_encoding_scope_and_supplier_groups() -> None:
    assert CLICKHOUSE_URL is not None
    service = GovernedVehicleAggregateService(
        GovernedSemanticRegistry.from_files(SEMANTIC_ROOT),
        LiveGovernedClickHouseAggregateExecutor(CLICKHOUSE_URL, "default", ""),
        scope_resolver=DemoScopeResolver(),
    )

    june = await service.aggregate(_request("2026-06"), _principal())
    may = await service.aggregate(_request("2026-05"), _principal())
    grouped = await service.aggregate(_request("2026-06", grouped=True), _principal())

    assert june.value == 11
    assert may.value == 8
    assert june.completeness == "complete"
    assert june.provenance.aggregation == "count_distinct"
    assert june.provenance.pushdown == "clickhouse"
    assert {item.keys["vehicle.dimension.supplier"]: item.value for item in grouped.groups} == {
        "演示供应商 A": 5,
        "演示供应商 B": 3,
        "演示供应商 C": 3,
    }
    serialized = june.model_dump_json(by_alias=True)
    assert "demo-hq" not in serialized
    assert "outside-scope" not in serialized
