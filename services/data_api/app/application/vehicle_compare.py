from __future__ import annotations

import json
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Literal

from pydantic import Field, model_validator

from app.application.vehicle_aggregate import (
    AggregateFilter,
    AggregateGroup,
    BusinessMonth,
    ContractModel,
    GovernedVehicleAggregateService,
    VehicleAggregateError,
    VehicleAggregateRequest,
    VehicleAggregateResponse,
)
from app.domain.identity import Principal

_GROUP_COMPARISON_LIMIT = 200


class VehicleCompareRequest(ContractModel):
    metric_id: str = Field(
        min_length=1,
        max_length=160,
        pattern=r"^[a-z][a-z0-9_.-]{0,159}$",
    )
    current_time: BusinessMonth
    baseline_time: BusinessMonth
    group_by_field_ids: list[str] = Field(default_factory=list, max_length=8)
    filters: list[AggregateFilter] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_periods(self) -> VehicleCompareRequest:
        if self.current_time.value == self.baseline_time.value:
            raise ValueError("currentTime and baselineTime must be different")
        return self

    def aggregate_request(self, time: BusinessMonth) -> VehicleAggregateRequest:
        return VehicleAggregateRequest(
            metric_id=self.metric_id,
            time=time,
            group_by_field_ids=self.group_by_field_ids,
            filters=self.filters,
        )


class PeriodChange(ContractModel):
    absolute_change: int | float | str
    percent_change: float | None
    direction: Literal["increase", "decrease", "unchanged"]
    status: Literal["computed", "baseline_zero"]


class CompareGroup(ContractModel):
    keys: dict[str, str | int | float | None]
    current_value: int | float | str
    baseline_value: int | float | str
    change: PeriodChange


class CompareProvenance(ContractModel):
    calculation: Literal["period_over_period"]
    comparison_basis: Literal["same_metric_same_principal_scope_same_filters"]
    group_result_limit: int | None
    group_result_truncated: bool


class VehicleCompareResponse(ContractModel):
    metric_id: str
    label: str
    unit: str
    current: VehicleAggregateResponse
    baseline: VehicleAggregateResponse
    change: PeriodChange | None
    groups: list[CompareGroup]
    completeness: Literal["complete", "partial"]
    provenance: CompareProvenance


class GovernedVehicleCompareService:
    def __init__(self, aggregate_service: GovernedVehicleAggregateService) -> None:
        self.aggregate_service = aggregate_service

    async def compare(
        self,
        request: VehicleCompareRequest,
        principal: Principal,
    ) -> VehicleCompareResponse:
        current, baseline = await self.aggregate_service.aggregate_many(
            (
                request.aggregate_request(request.current_time),
                request.aggregate_request(request.baseline_time),
            ),
            principal,
        )
        _assert_compatible(current, baseline)

        group_result_truncated = False
        if request.group_by_field_ids:
            change = None
            if current.completeness == "complete" and baseline.completeness == "complete":
                groups = _compare_groups(current.groups, baseline.groups)
                if len(groups) > _GROUP_COMPARISON_LIMIT:
                    groups = groups[:_GROUP_COMPARISON_LIMIT]
                    group_result_truncated = True
            else:
                groups = []
                group_result_truncated = True
        else:
            if current.value is None or baseline.value is None:
                raise VehicleAggregateError(
                    "RESULT_SCHEMA_MISMATCH",
                    "Ungrouped comparison requires two aggregate values",
                    502,
                )
            change = _change(current.value, baseline.value)
            groups = []

        completeness = (
            "partial"
            if current.completeness == "partial"
            or baseline.completeness == "partial"
            or group_result_truncated
            else "complete"
        )
        return VehicleCompareResponse(
            metric_id=current.metric_id,
            label=current.label,
            unit=current.unit,
            current=current,
            baseline=baseline,
            change=change,
            groups=groups,
            completeness=completeness,
            provenance=CompareProvenance(
                calculation="period_over_period",
                comparison_basis="same_metric_same_principal_scope_same_filters",
                group_result_limit=_GROUP_COMPARISON_LIMIT if request.group_by_field_ids else None,
                group_result_truncated=group_result_truncated,
            ),
        )


def _assert_compatible(
    current: VehicleAggregateResponse,
    baseline: VehicleAggregateResponse,
) -> None:
    if (
        current.metric_id != baseline.metric_id
        or current.label != baseline.label
        or current.unit != baseline.unit
        or current.provenance.aggregation != baseline.provenance.aggregation
        or current.provenance.scope != baseline.provenance.scope
    ):
        raise VehicleAggregateError(
            "COMPARISON_BASIS_MISMATCH",
            "Period comparison inputs do not share one governed metric and scope",
            502,
        )


def _compare_groups(
    current_groups: list[AggregateGroup],
    baseline_groups: list[AggregateGroup],
) -> list[CompareGroup]:
    current = {_group_key(item.keys): item for item in current_groups}
    baseline = {_group_key(item.keys): item for item in baseline_groups}
    groups: list[CompareGroup] = []
    for key in current.keys() | baseline.keys():
        current_group = current.get(key)
        baseline_group = baseline.get(key)
        source_group = current_group if current_group is not None else baseline_group
        assert source_group is not None
        keys = dict(source_group.keys)
        current_value = current_group.value if current_group is not None else 0
        baseline_value = baseline_group.value if baseline_group is not None else 0
        groups.append(
            CompareGroup(
                keys=keys,
                current_value=current_value,
                baseline_value=baseline_value,
                change=_change(current_value, baseline_value),
            )
        )
    return sorted(
        groups,
        key=lambda item: (
            -abs(_as_decimal(item.change.absolute_change)),
            _group_key(item.keys),
        ),
    )


def _group_key(keys: dict[str, str | int | float | None]) -> str:
    return json.dumps(keys, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _change(current: int | float | str, baseline: int | float | str) -> PeriodChange:
    current_value = _as_decimal(current)
    baseline_value = _as_decimal(baseline)
    absolute = current_value - baseline_value
    direction: Literal["increase", "decrease", "unchanged"] = (
        "increase" if absolute > 0 else "decrease" if absolute < 0 else "unchanged"
    )
    if baseline_value == 0:
        percent_change = None
        status: Literal["computed", "baseline_zero"] = "baseline_zero"
    else:
        percent_change = float(
            ((absolute / baseline_value) * Decimal(100)).quantize(
                Decimal("0.0001"),
                rounding=ROUND_HALF_UP,
            )
        )
        status = "computed"
    return PeriodChange(
        absolute_change=_contract_number(absolute),
        percent_change=percent_change,
        direction=direction,
        status=status,
    )


def _as_decimal(value: int | float | str) -> Decimal:
    if isinstance(value, bool):
        raise VehicleAggregateError("RESULT_SCHEMA_MISMATCH", "Comparison value is not numeric", 502)
    try:
        return Decimal(str(value))
    except InvalidOperation as error:
        raise VehicleAggregateError(
            "RESULT_SCHEMA_MISMATCH",
            "Comparison value is not numeric",
            502,
        ) from error


def _contract_number(value: Decimal) -> int | str:
    if value == 0:
        return 0
    if value == value.to_integral_value():
        return int(value)
    return format(value.normalize(), "f")
