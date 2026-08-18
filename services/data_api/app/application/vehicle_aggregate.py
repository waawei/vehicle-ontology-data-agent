from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from app.domain.identity import Principal

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_METRIC_ID = re.compile(r"^[a-z][a-z0-9_.-]{0,159}$")
_MONTH = re.compile(r"^(?P<year>\d{4})-(?P<month>0[1-9]|1[0-2])$")
_GROUP_RESULT_LIMIT = 200
_HIGH_CARDINALITY_GROUP_FIELDS = frozenset({"vehicle.dimension.vehicle", "vehicle.dimension.employee"})


def _camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(item[:1].upper() + item[1:] for item in tail)


class VehicleAggregateError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        status_code: int = 409,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


class ContractModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel,
        populate_by_name=True,
        extra="forbid",
    )


class BusinessMonth(ContractModel):
    kind: str = Field(pattern=r"^business_month$")
    value: str

    @field_validator("value")
    @classmethod
    def validate_value(cls, value: str) -> str:
        if _MONTH.fullmatch(value) is None:
            raise ValueError("business month must use YYYY-MM")
        return value


class AggregateFilter(ContractModel):
    field_id: str = Field(min_length=1, max_length=160)
    operator: str = Field(default="eq", pattern=r"^eq$")
    value: str = Field(min_length=1, max_length=160)


class VehicleAggregateRequest(ContractModel):
    metric_id: str = Field(min_length=1, max_length=160)
    time: BusinessMonth
    group_by_field_ids: list[str] = Field(default_factory=list, max_length=8)
    filters: list[AggregateFilter] = Field(default_factory=list, max_length=20)

    @field_validator("metric_id")
    @classmethod
    def validate_metric_id(cls, value: str) -> str:
        if _METRIC_ID.fullmatch(value) is None:
            raise ValueError("metricId is invalid")
        return value


class AggregateGroup(ContractModel):
    keys: dict[str, str | int | float | None]
    value: int | float | str


class OrganizationAttributionTimeRange(ContractModel):
    kind: Literal["business_month"]
    start: str
    end: str

    @field_validator("start", "end")
    @classmethod
    def validate_month(cls, value: str) -> str:
        if _MONTH.fullmatch(value) is None:
            raise ValueError("organization attribution time range must use YYYY-MM")
        return value

    @model_validator(mode="after")
    def validate_order(self) -> OrganizationAttributionTimeRange:
        if self.start > self.end:
            raise ValueError("organization attribution time range is reversed")
        return self


class OrganizationAttributionQuality(ContractModel):
    status: Literal["not_measured", "measured"]
    coverage: float | None = Field(ge=0, le=1)
    numerator: int | None = Field(ge=0)
    denominator: int | None = Field(ge=1)
    basis: Literal["metric_identity"]
    time_range: OrganizationAttributionTimeRange | None
    topology_version: str | None = Field(min_length=1)

    @model_validator(mode="after")
    def validate_measurement(self) -> OrganizationAttributionQuality:
        values = (
            self.coverage,
            self.numerator,
            self.denominator,
            self.time_range,
            self.topology_version,
        )
        if self.status == "not_measured":
            if any(value is not None for value in values):
                raise ValueError("not_measured organization attribution cannot contain statistics")
            return self
        if any(value is None for value in values):
            raise ValueError("measured organization attribution requires complete build metadata")
        assert self.coverage is not None
        assert self.numerator is not None
        assert self.denominator is not None
        if self.numerator > self.denominator:
            raise ValueError("organization attribution numerator exceeds denominator")
        expected = self.numerator / self.denominator
        if abs(self.coverage - expected) > 1e-12:
            raise ValueError("organization attribution coverage does not match numerator/denominator")
        return self


class AggregateDataQuality(ContractModel):
    organization_attribution: OrganizationAttributionQuality


class AggregateProvenance(ContractModel):
    source_id: str
    aggregation: Literal["count_distinct"]
    identity_field_id: str
    organization_field_id: str
    business_time_field_id: str
    scope: Literal["principal_organization_scope"]
    pushdown: Literal["clickhouse"]
    source_time_coverage: float | None
    group_result_limit: int | None
    group_result_truncated: bool


class VehicleAggregateResponse(ContractModel):
    metric_id: str
    label: str
    value: int | float | str | None
    unit: str
    time: BusinessMonth
    groups: list[AggregateGroup]
    completeness: Literal["complete", "partial"]
    data_quality: AggregateDataQuality
    provenance: AggregateProvenance


@dataclass(frozen=True)
class CompiledAggregate:
    metric_id: str
    label: str
    unit: str
    time: BusinessMonth
    sql: str
    parameters: dict[str, str]
    organization_scope: tuple[str, ...]
    source_id: str
    identity_field_id: str
    organization_field_id: str
    business_time_field_id: str
    group_fields: tuple[tuple[str, str, str], ...]
    group_result_limit: int | None
    source_time_coverage: float | None
    organization_attribution: OrganizationAttributionQuality


class AggregateExecutor(Protocol):
    async def execute(self, compiled: CompiledAggregate) -> list[dict[str, Any]]: ...


class OrganizationScopeResolver(Protocol):
    async def resolve(self, authorization_roots: tuple[str, ...]) -> tuple[str, ...]: ...


class OrganizationTopologyMappingResolver(Protocol):
    async def resolve(self, tenant_id: str, organization_ids: tuple[str, ...]) -> tuple[str, ...]: ...


class UnavailableAggregateExecutor:
    async def execute(self, compiled: CompiledAggregate) -> list[dict[str, Any]]:
        del compiled
        raise VehicleAggregateError(
            "CLICKHOUSE_UNAVAILABLE",
            "ClickHouse aggregate connector is not configured; no business value was computed",
            503,
        )


def _identifier(value: Any) -> str:
    candidate = str(value or "")
    if _IDENTIFIER.fullmatch(candidate) is None:
        raise VehicleAggregateError(
            "SEMANTIC_BINDING_INVALID",
            "Governed binding contains an invalid physical identifier",
        )
    return candidate


def _physical_business_month(time_axis: Mapping[str, Any], value: str) -> str:
    month_match = _MONTH.fullmatch(value)
    assert month_match is not None
    encoding = time_axis.get("kind")
    if encoding == "month_zh":
        return f"{month_match.group('year')}年{month_match.group('month')}月"
    if encoding == "month":
        return value
    raise VehicleAggregateError(
        "BUSINESS_TIME_ENCODING_UNSUPPORTED",
        "Business month has no governed source encoding",
        details={"encoding": encoding},
    )


def _metric_unit(policy: Mapping[str, Any]) -> str:
    unit = str(policy.get("unit") or "")
    if unit != "count":
        return unit
    subject = str(policy.get("subject") or "")
    if subject == "vehicle":
        return "辆"
    if subject.endswith("_order"):
        return "单"
    return "个"


def _organization_attribution_quality(
    dataset: Mapping[str, Any],
) -> OrganizationAttributionQuality:
    metadata = dataset.get("organizationAttribution")
    if metadata is None:
        return OrganizationAttributionQuality(
            status="not_measured",
            coverage=None,
            numerator=None,
            denominator=None,
            basis="metric_identity",
            time_range=None,
            topology_version=None,
        )
    if not isinstance(metadata, Mapping):
        raise VehicleAggregateError(
            "DATASET_BINDING_INVALID",
            "Organization attribution quality metadata is invalid",
        )
    try:
        return OrganizationAttributionQuality.model_validate(dict(metadata))
    except ValidationError as error:
        raise VehicleAggregateError(
            "DATASET_BINDING_INVALID",
            "Organization attribution quality metadata is incomplete or inconsistent",
        ) from error


def _load_json(path: Path, *, code: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VehicleAggregateError(code, f"Governed registry is unavailable: {path.name}", 503) from error
    if not isinstance(value, dict):
        raise VehicleAggregateError(code, f"Governed registry is invalid: {path.name}", 503)
    return value


class GovernedSemanticRegistry:
    """Server-only metric, field-binding, dataset, and mount registry."""

    def __init__(
        self,
        semantic_index: Mapping[str, Any],
        schema_topology: Mapping[str, Any],
        metric_registry: Mapping[str, Any],
        dataset_registry: Mapping[str, Any],
    ) -> None:
        self.semantic_index = dict(semantic_index)
        self.schema_topology = dict(schema_topology)
        self.metric_registry = dict(metric_registry)
        self.dataset_registry = dict(dataset_registry)
        if self.semantic_index.get("workspaceId") != self.schema_topology.get(
            "workspaceId"
        ) or self.semantic_index.get("resourceVersion") != self.schema_topology.get("resourceVersion"):
            raise VehicleAggregateError(
                "SEMANTIC_INDEX_VERSION_MISMATCH",
                "Semantic Index and Schema Topology are not one governed release",
                503,
            )

    @classmethod
    def from_files(cls, semantic_root: Path) -> GovernedSemanticRegistry:
        source_registry = semantic_root / "source-registry"
        return cls(
            _load_json(semantic_root / "semantic-index.json", code="SEMANTIC_INDEX_UNAVAILABLE"),
            _load_json(semantic_root / "schema-topology.json", code="SCHEMA_TOPOLOGY_UNAVAILABLE"),
            _load_json(source_registry / "metric-definitions-v3.json", code="METRIC_REGISTRY_UNAVAILABLE"),
            _load_json(source_registry / "controlled-datasets-v3.json", code="DATASET_REGISTRY_UNAVAILABLE"),
        )

    def semantic_metric(self, metric_id: str) -> dict[str, Any]:
        return self._find(
            self.semantic_index.get("metricDefinitions"),
            key="metricId",
            value=metric_id,
            code="METRIC_NOT_FOUND",
            message="Requested metric is not published in the Semantic Index",
            status_code=404,
        )

    def metric_policy(self, metric_id: str) -> dict[str, Any]:
        return self._find(
            self.metric_registry.get("metrics"),
            key="metricId",
            value=metric_id,
            code="METRIC_POLICY_NOT_FOUND",
            message="Requested metric has no governed Metric Definition",
        )

    def mount(self, mount_id: str) -> dict[str, Any]:
        return self._find(
            self.schema_topology.get("mounts"),
            key="mountId",
            value=mount_id,
            code="FACT_MOUNT_NOT_FOUND",
            message="Metric fact mount is not published",
        )

    def dataset(self, dataset_id: str) -> dict[str, Any]:
        return self._find(
            self.dataset_registry.get("datasets"),
            key="datasetId",
            value=dataset_id,
            code="DATASET_BINDING_NOT_FOUND",
            message="Metric controlled dataset binding is not published",
        )

    @staticmethod
    def _find(
        values: Any,
        *,
        key: str,
        value: str,
        code: str,
        message: str,
        status_code: int = 409,
    ) -> dict[str, Any]:
        matches = [
            dict(item) for item in values or [] if isinstance(item, Mapping) and item.get(key) == value
        ]
        if len(matches) != 1:
            raise VehicleAggregateError(code, message, status_code, {key: value, "matchCount": len(matches)})
        return matches[0]


class GovernedVehicleAggregateCompiler:
    def __init__(self, registry: GovernedSemanticRegistry) -> None:
        self.registry = registry

    @staticmethod
    def _single_mapping(metric: Mapping[str, Any], role: str) -> dict[str, Any]:
        values = metric.get("fieldMappings")
        matches = [
            dict(item) for item in values or [] if isinstance(item, Mapping) and item.get("role") == role
        ]
        if len(matches) != 1:
            raise VehicleAggregateError(
                "FIELD_BINDING_INVALID",
                f"Metric does not have exactly one {role} field binding",
            )
        return matches[0]

    def compile(
        self,
        request: VehicleAggregateRequest,
        organization_scope: tuple[str, ...],
    ) -> CompiledAggregate:
        scope = tuple(sorted({item.strip() for item in organization_scope if item.strip()}))
        if not scope:
            raise VehicleAggregateError(
                "PRINCIPAL_SCOPE_EMPTY",
                "Principal has no effective organization scope",
                403,
            )
        metric = self.registry.semantic_metric(request.metric_id)
        policy = self.registry.metric_policy(request.metric_id)
        if (
            metric.get("approvalStatus") != "published"
            or metric.get("publicationStatus") != "published_executable"
            or metric.get("executable") is not True
            or policy.get("approval", {}).get("status") != "approved"
        ):
            raise VehicleAggregateError(
                "METRIC_NOT_EXECUTABLE",
                "Requested metric has no published governed executor",
            )
        if metric.get("aggregator") != "count_distinct" or policy.get("aggregation") != "count_distinct":
            raise VehicleAggregateError(
                "AGGREGATION_NOT_ALLOWED",
                "Only the registered count_distinct vertical slice is enabled",
            )
        source_sets = metric.get("sourceEventSetIds")
        requirements = metric.get("evidenceRequirements")
        mount_ids = requirements.get("mountIds") if isinstance(requirements, Mapping) else None
        if (
            not isinstance(source_sets, list)
            or len(source_sets) != 1
            or not isinstance(mount_ids, list)
            or len(mount_ids) != 1
        ):
            raise VehicleAggregateError(
                "SEMANTIC_BINDING_INVALID",
                "Metric source and mount binding is incomplete",
            )
        mount_id = str(mount_ids[0])
        mount = self.registry.mount(mount_id)
        if (
            mount.get("eventSetId") != source_sets[0]
            or mount.get("accessMode") != "read_only"
            or mount.get("sourceKind") != "clickhouse"
            or mount.get("approvalStatus") != "published"
        ):
            raise VehicleAggregateError(
                "FACT_MOUNT_INVALID",
                "Metric is not bound to one published read-only ClickHouse mount",
            )
        database = _identifier(mount.get("database"))
        table = _identifier(mount.get("table"))
        source_table = f"{database}.{table}"
        dataset = self.registry.dataset(str(policy.get("datasetId") or ""))
        if dataset.get("status") != "approved" or dataset.get("sourceObject") != source_table:
            raise VehicleAggregateError(
                "DATASET_BINDING_INVALID",
                "Metric dataset does not match the published mount",
            )
        allowlist = {str(item) for item in mount.get("fieldAllowlist", [])}
        identity = self._single_mapping(metric, "identity_key")
        organization = self._single_mapping(metric, "organization_key")
        business_time = self._single_mapping(metric, "business_time")
        identity_column = _identifier(identity.get("sourceColumn"))
        organization_column = _identifier(organization.get("sourceColumn"))
        business_time_column = _identifier(business_time.get("sourceColumn"))
        required_columns = {identity_column, organization_column, business_time_column}
        if not required_columns.issubset(allowlist):
            raise VehicleAggregateError(
                "FIELD_BINDING_INVALID",
                "Metric binding is outside the mount field allowlist",
            )
        fact_bindings = dataset.get("factBindings")
        if not isinstance(fact_bindings, Mapping):
            raise VehicleAggregateError("DATASET_BINDING_INVALID", "Controlled dataset has no field bindings")
        if (
            identity.get("logicalFieldId") != policy.get("measureFactId")
            or fact_bindings.get(str(policy.get("measureFactId"))) != identity_column
        ):
            raise VehicleAggregateError(
                "IDENTITY_BINDING_INVALID",
                "Metric distinct identity does not match the controlled dataset",
            )
        mount_organization = mount.get("organizationField")
        mount_time = mount.get("businessTimeField")
        if (
            not isinstance(mount_organization, Mapping)
            or mount_organization.get("sourceColumn") != organization_column
            or not isinstance(mount_time, Mapping)
            or mount_time.get("sourceColumn") != business_time_column
        ):
            raise VehicleAggregateError(
                "FIELD_BINDING_INVALID",
                "Metric scope or business-time field does not match the mount",
            )
        time_axis_name = str(policy.get("timeAxis") or "")
        time_axes = dataset.get("timeAxes")
        time_axis = time_axes.get(time_axis_name) if isinstance(time_axes, Mapping) else None
        if not isinstance(time_axis, Mapping) or time_axis.get("sourceField") != business_time_column:
            raise VehicleAggregateError(
                "BUSINESS_TIME_ENCODING_UNSUPPORTED",
                "Business month has no governed source encoding",
            )
        physical_month = _physical_business_month(time_axis, request.time.value)
        identity_expression = f"trimBoth(ifNull({identity_column}, ''))"
        clauses = [
            f"{business_time_column} = {{businessMonth:String}}",
            f"{organization_column} IN (SELECT organizationId FROM scopeOrganizations)",
        ]
        parameters = {"businessMonth": physical_month}
        dimensions = {
            str(item.get("fieldId")): dict(item)
            for item in metric.get("dimensions", [])
            if isinstance(item, Mapping) and item.get("fieldId")
        }
        mappings = {
            str(item.get("logicalFieldId")): dict(item)
            for item in metric.get("fieldMappings", [])
            if isinstance(item, Mapping) and item.get("logicalFieldId")
        }
        group_fields: list[tuple[str, str, str]] = []
        seen_group_fields: set[str] = set()
        for index, field_id in enumerate(request.group_by_field_ids):
            binding = mappings.get(field_id)
            if field_id in seen_group_fields or field_id not in dimensions:
                raise VehicleAggregateError(
                    "GROUP_BY_NOT_ALLOWED",
                    "Requested group field is not allowed by the metric",
                    422,
                    {"fieldId": field_id},
                )
            if binding and binding.get("role") == "organization_key":
                raise VehicleAggregateError(
                    "ORGANIZATION_GROUPING_FORBIDDEN",
                    "Organization identifiers cannot be returned as aggregate groups",
                    403,
                )
            if field_id in _HIGH_CARDINALITY_GROUP_FIELDS:
                raise VehicleAggregateError(
                    "GROUP_BY_CAPABILITY_LIMITED",
                    "Requested high-cardinality group field has no published result policy",
                    422,
                    {"fieldId": field_id},
                )
            if not binding or binding.get("role") != "dimension":
                raise VehicleAggregateError(
                    "FIELD_BINDING_INVALID",
                    "Requested group field has no governed dimension binding",
                )
            column = _identifier(binding.get("sourceColumn"))
            if column not in allowlist:
                raise VehicleAggregateError(
                    "FIELD_BINDING_INVALID",
                    "Requested group field is outside the mount allowlist",
                )
            group_fields.append((field_id, column, f"group_{index}"))
            seen_group_fields.add(field_id)
        for index, item in enumerate(request.filters):
            binding = mappings.get(item.field_id)
            if item.field_id not in dimensions or not binding:
                raise VehicleAggregateError(
                    "FILTER_NOT_ALLOWED",
                    "Requested filter is not allowed by the metric",
                    422,
                    {"fieldId": item.field_id},
                )
            if binding.get("role") == "organization_key":
                raise VehicleAggregateError(
                    "ORGANIZATION_SCOPE_OVERRIDE",
                    "Organization filtering comes only from Principal",
                    403,
                )
            if binding.get("role") != "dimension":
                raise VehicleAggregateError(
                    "FILTER_NOT_ALLOWED",
                    "Requested filter has no governed dimension binding",
                    422,
                )
            column = _identifier(binding.get("sourceColumn"))
            if column not in allowlist:
                raise VehicleAggregateError(
                    "FIELD_BINDING_INVALID",
                    "Requested filter is outside the mount allowlist",
                )
            parameter = f"filter_{index}"
            parameters[parameter] = item.value
            clauses.append(f"{column} = {{{parameter}:String}}")
        select_parts = [f"{column} AS {alias}" for _, column, alias in group_fields]
        select_parts.append(f"uniqExactIf({identity_expression}, notEmpty({identity_expression})) AS value")
        group_clause = f" GROUP BY {', '.join(alias for _, _, alias in group_fields)}" if group_fields else ""
        order_clause = f" ORDER BY {', '.join(alias for _, _, alias in group_fields)}" if group_fields else ""
        group_result_limit = _GROUP_RESULT_LIMIT if group_fields else None
        limit_clause = f" LIMIT {_GROUP_RESULT_LIMIT + 1}" if group_result_limit is not None else ""
        sql = (
            f"SELECT {', '.join(select_parts)} FROM {source_table} "
            f"WHERE {' AND '.join(clauses)}{group_clause}{order_clause}{limit_clause} FORMAT JSON"
        )
        coverage = time_axis.get("completeness")
        return CompiledAggregate(
            metric_id=request.metric_id,
            label=str(metric.get("canonicalNameZh") or request.metric_id),
            unit=_metric_unit(policy),
            time=request.time,
            sql=sql,
            parameters=parameters,
            organization_scope=scope,
            source_id=mount_id,
            identity_field_id=str(identity.get("logicalFieldId")),
            organization_field_id=str(organization.get("logicalFieldId")),
            business_time_field_id=str(business_time.get("logicalFieldId")),
            group_fields=tuple(group_fields),
            group_result_limit=group_result_limit,
            source_time_coverage=float(coverage) if isinstance(coverage, int | float) else None,
            organization_attribution=_organization_attribution_quality(dataset),
        )


class GovernedVehicleAggregateService:
    def __init__(
        self,
        registry: GovernedSemanticRegistry,
        executor: AggregateExecutor,
        *,
        scope_resolver: OrganizationScopeResolver | None = None,
        topology_mapping_resolver: OrganizationTopologyMappingResolver | None = None,
    ) -> None:
        self.compiler = GovernedVehicleAggregateCompiler(registry)
        self.executor = executor
        self.scope_resolver = scope_resolver
        self.topology_mapping_resolver = topology_mapping_resolver

    async def aggregate(
        self,
        request: VehicleAggregateRequest,
        principal: Principal,
    ) -> VehicleAggregateResponse:
        return (await self.aggregate_many((request,), principal))[0]

    async def aggregate_many(
        self,
        requests: tuple[VehicleAggregateRequest, ...],
        principal: Principal,
    ) -> list[VehicleAggregateResponse]:
        if not requests:
            return []
        scope = await self._resolve_scope(principal)
        results: list[VehicleAggregateResponse] = []
        for request in requests:
            results.append(await self._aggregate_in_scope(request, scope))
        return results

    async def _resolve_scope(self, principal: Principal) -> tuple[str, ...]:
        roots = tuple(sorted(principal.organization_ids))
        if not roots:
            raise VehicleAggregateError(
                "PRINCIPAL_SCOPE_EMPTY",
                "Principal has no effective organization scope",
                403,
            )
        try:
            mapped_roots = (
                await self.topology_mapping_resolver.resolve(principal.tenant_id, roots)
                if self.topology_mapping_resolver is not None
                else roots
            )
            scope = (
                await self.scope_resolver.resolve(mapped_roots)
                if self.scope_resolver is not None
                else mapped_roots
            )
        except VehicleAggregateError:
            raise
        except Exception as error:
            raise VehicleAggregateError(
                str(getattr(error, "code", "ORGANIZATION_SCOPE_UNAVAILABLE")),
                str(getattr(error, "message", "Organization scope could not be resolved")),
                int(getattr(error, "status_code", 503)),
            ) from error
        return tuple(scope)

    async def _aggregate_in_scope(
        self,
        request: VehicleAggregateRequest,
        scope: tuple[str, ...],
    ) -> VehicleAggregateResponse:
        compiled = self.compiler.compile(request, scope)
        rows = await self.executor.execute(compiled)
        group_result_truncated = False
        if compiled.group_fields:
            value: int | float | str | None = None
            if compiled.group_result_limit is not None and len(rows) > compiled.group_result_limit:
                rows = rows[: compiled.group_result_limit]
                group_result_truncated = True
            groups = [
                AggregateGroup(
                    keys={field_id: row.get(alias) for field_id, _, alias in compiled.group_fields},
                    value=_numeric(row.get("value")),
                )
                for row in rows
            ]
        else:
            if len(rows) != 1:
                raise VehicleAggregateError(
                    "RESULT_SCHEMA_MISMATCH",
                    "ClickHouse aggregate result must contain exactly one row",
                    502,
                )
            value = _numeric(rows[0].get("value"))
            groups = []
        return VehicleAggregateResponse(
            metric_id=compiled.metric_id,
            label=compiled.label,
            value=value,
            unit=compiled.unit,
            time=compiled.time,
            groups=groups,
            completeness=_completeness(group_result_truncated=group_result_truncated),
            data_quality=AggregateDataQuality(
                organization_attribution=compiled.organization_attribution,
            ),
            provenance=AggregateProvenance(
                source_id=compiled.source_id,
                aggregation="count_distinct",
                identity_field_id=compiled.identity_field_id,
                organization_field_id=compiled.organization_field_id,
                business_time_field_id=compiled.business_time_field_id,
                scope="principal_organization_scope",
                pushdown="clickhouse",
                source_time_coverage=compiled.source_time_coverage,
                group_result_limit=compiled.group_result_limit,
                group_result_truncated=group_result_truncated,
            ),
        )


def _completeness(*, group_result_truncated: bool) -> Literal["complete", "partial"]:
    return "partial" if group_result_truncated else "complete"


def _numeric(value: Any) -> int | float | str:
    if isinstance(value, bool) or value is None:
        raise VehicleAggregateError(
            "RESULT_SCHEMA_MISMATCH",
            "Aggregate value is not numeric",
            502,
        )
    if isinstance(value, int | float):
        return value
    text = str(value).strip()
    try:
        return int(text)
    except ValueError:
        try:
            return float(text)
        except ValueError as error:
            raise VehicleAggregateError(
                "RESULT_SCHEMA_MISMATCH",
                "Aggregate value is not numeric",
                502,
            ) from error
