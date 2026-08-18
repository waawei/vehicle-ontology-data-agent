from __future__ import annotations

from typing import Any

import pytest

from app.application.vehicle_aggregate import (
    CompiledAggregate,
    GovernedSemanticRegistry,
    GovernedVehicleAggregateService,
)
from app.application.vehicle_compare import GovernedVehicleCompareService, VehicleCompareRequest
from app.domain.identity import Principal


@pytest.mark.asyncio
async def test_period_compare_uses_same_principal_scope_and_server_calculation(
    registry: GovernedSemanticRegistry,
    principal: Principal,
) -> None:
    class Executor:
        calls: list[CompiledAggregate]

        def __init__(self) -> None:
            self.calls = []

        async def execute(self, compiled: CompiledAggregate) -> list[dict[str, Any]]:
            self.calls.append(compiled)
            values: dict[str, list[dict[str, Any]]] = {
                "2026年06月": [{"value": "11"}],
                "2026年05月": [{"value": "8"}],
            }
            return values[compiled.parameters["businessMonth"]]

    executor = Executor()
    service = GovernedVehicleCompareService(GovernedVehicleAggregateService(registry, executor))
    result = await service.compare(
        VehicleCompareRequest.model_validate(
            {
                "metricId": "vehicle.count.short_rental_order",
                "currentTime": {"kind": "business_month", "value": "2026-06"},
                "baselineTime": {"kind": "business_month", "value": "2026-05"},
                "groupByFieldIds": [],
                "filters": [],
            }
        ),
        principal,
    )

    assert len(executor.calls) == 2
    assert all(call.organization_scope == ("principal-root",) for call in executor.calls)
    assert result.current.value == 11
    assert result.baseline.value == 8
    assert result.change is not None
    assert result.change.absolute_change == 3
    assert result.change.percent_change == 37.5
    assert result.provenance.comparison_basis == "same_metric_same_principal_scope_same_filters"
