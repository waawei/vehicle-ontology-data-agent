import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { RuntimeConfig } from "./config.js";

export const VEHICLE_AGGREGATE_TOOL_NAME = "vehicle_aggregate";
export const VEHICLE_AGGREGATE_ENDPOINT = "/tools/vehicle.aggregate";

export type AggregateScalar = number | string | null;

export interface OrganizationAttributionQuality {
  status: "not_measured" | "measured";
  coverage: number | null;
  numerator: number | null;
  denominator: number | null;
  basis: "metric_identity";
  timeRange: { kind: "business_month"; start: string; end: string } | null;
  topologyVersion: string | null;
}

export interface VehicleAggregateObservation {
  metricId: string;
  label: string;
  value: AggregateScalar;
  unit: string;
  time: { kind: "business_month"; value: string };
  groups: Array<{ keys: Record<string, string | number | null>; value: Exclude<AggregateScalar, null> }>;
  completeness: "complete" | "partial";
  dataQuality: {
    organizationAttribution: OrganizationAttributionQuality;
  };
  provenance: {
    sourceId: string;
    aggregation: "count_distinct";
    identityFieldId: string;
    organizationFieldId: "vehicle.dimension.organization";
    businessTimeFieldId: string;
    scope: "principal_organization_scope";
    pushdown: "clickhouse";
    sourceTimeCoverage: number | null;
    groupResultLimit: number | null;
    groupResultTruncated: boolean;
  };
}

const VehicleAggregateInput = Type.Object(
  {
    metricId: Type.String({ minLength: 1, maxLength: 160 }),
    time: Type.Object(
      {
        kind: Type.Literal("business_month"),
        value: Type.String({ pattern: "^[0-9]{4}-(0[1-9]|1[0-2])$" }),
      },
      { additionalProperties: false },
    ),
    groupByFieldIds: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
      default: [],
      maxItems: 8,
    }),
    filters: Type.Array(
      Type.Object(
        {
          fieldId: Type.String({ minLength: 1, maxLength: 160 }),
          operator: Type.Literal("eq"),
          value: Type.String({ minLength: 1, maxLength: 160 }),
        },
        { additionalProperties: false },
      ),
      { default: [], maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);

export function createVehicleAggregateTool(
  config: RuntimeConfig,
  cookie: string,
  fetchImpl: typeof fetch = fetch,
  allowedMetricIds?: readonly string[],
): AgentTool<typeof VehicleAggregateInput> {
  const metricAllowlist = allowedMetricIds ? new Set(allowedMetricIds) : undefined;
  const metricDescription = allowedMetricIds?.length
    ? ` 当前 Skill 只允许：${allowedMetricIds.join(", ")}。`
    : "";
  return {
    name: VEHICLE_AGGREGATE_TOOL_NAME,
    label: "车辆指标聚合",
    description:
      `调用受治理的车辆聚合服务。只能提交 semantic metric、业务时间、允许的分组和过滤，组织范围由服务端 Principal 注入。${metricDescription}`,
    parameters: VehicleAggregateInput,
    executionMode: "sequential",
    execute: async (_toolCallId, parameters, signal) => {
      if (metricAllowlist && !metricAllowlist.has(parameters.metricId)) {
        throw new Error(
          `VEHICLE_TOOL_METRIC_NOT_ALLOWED: Metric ${parameters.metricId} is not allowed by the active Skill`,
        );
      }
      const response = await fetchImpl(`${config.agentApiUrl}${VEHICLE_AGGREGATE_ENDPOINT}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(parameters),
        ...(signal ? { signal } : {}),
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("VEHICLE_TOOL_RESPONSE_INVALID: Vehicle tool returned invalid JSON");
      }
      if (!response.ok) {
        const error = extractToolError(payload);
        throw new Error(`${error.code}: ${error.message}`);
      }
      const observation = validateVehicleAggregateObservation(payload);
      return {
        content: [{ type: "text", text: JSON.stringify(observation) }],
        details: { observation },
      };
    },
  };
}

export function validateVehicleAggregateObservation(payload: unknown): VehicleAggregateObservation {
  if (!isRecord(payload)) invalidResponse("response must be an object");
  const value = numericScalar(payload.value, true, "value");
  if (!isRecord(payload.time)
    || payload.time.kind !== "business_month"
    || typeof payload.time.value !== "string"
    || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(payload.time.value)) {
    invalidResponse("time must be a valid business_month");
  }
  if (!Array.isArray(payload.groups)) invalidResponse("groups must be an array");
  const groups = payload.groups.map((group, index) => validateGroup(group, index));
  if (!new Set(["complete", "partial"]).has(String(payload.completeness))) {
    invalidResponse("completeness is invalid");
  }
  const organizationAttribution = validateOrganizationAttribution(payload.dataQuality);
  if (!isRecord(payload.provenance)) invalidResponse("provenance must be an object");
  const provenance = payload.provenance;
  const requiredStrings = [
    "sourceId",
    "identityFieldId",
    "businessTimeFieldId",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof provenance[key] !== "string" || !provenance[key].trim()) {
      invalidResponse(`provenance.${key} is required`);
    }
  }
  if (provenance.aggregation !== "count_distinct"
    || provenance.organizationFieldId !== "vehicle.dimension.organization"
    || provenance.scope !== "principal_organization_scope"
    || provenance.pushdown !== "clickhouse") {
    invalidResponse("provenance governance markers are invalid");
  }
  if (provenance.sourceTimeCoverage !== null
    && (typeof provenance.sourceTimeCoverage !== "number"
      || !Number.isFinite(provenance.sourceTimeCoverage)
      || provenance.sourceTimeCoverage < 0
      || provenance.sourceTimeCoverage > 1)) {
    invalidResponse("provenance.sourceTimeCoverage is invalid");
  }
  if ("organizationAttributionCoverage" in provenance) {
    invalidResponse("legacy provenance.organizationAttributionCoverage is forbidden");
  }
  if (provenance.groupResultLimit !== null
    && (!Number.isInteger(provenance.groupResultLimit) || Number(provenance.groupResultLimit) < 1)) {
    invalidResponse("provenance.groupResultLimit is invalid");
  }
  if (typeof provenance.groupResultTruncated !== "boolean") {
    invalidResponse("provenance.groupResultTruncated is required");
  }
  const expectedCompleteness = provenance.groupResultTruncated ? "partial" : "complete";
  if (payload.completeness !== expectedCompleteness) {
    invalidResponse("completeness does not match result truncation");
  }
  if (typeof payload.metricId !== "string" || !payload.metricId.trim()
    || typeof payload.label !== "string" || !payload.label.trim()
    || typeof payload.unit !== "string" || !payload.unit.trim()) {
    invalidResponse("metricId, label, and unit are required");
  }
  const grouped = provenance.groupResultLimit !== null;
  if (grouped && value !== null) invalidResponse("grouped observations must have a null top-level value");
  if (!grouped && value === null) invalidResponse("ungrouped observations must have a value");
  if (!grouped && groups.length) invalidResponse("ungrouped observations cannot contain groups");
  return {
    metricId: payload.metricId,
    label: payload.label,
    value,
    unit: payload.unit,
    time: { kind: "business_month", value: payload.time.value },
    groups,
    completeness: payload.completeness as VehicleAggregateObservation["completeness"],
    dataQuality: { organizationAttribution },
    provenance: {
      sourceId: provenance.sourceId as string,
      aggregation: "count_distinct",
      identityFieldId: provenance.identityFieldId as string,
      organizationFieldId: "vehicle.dimension.organization",
      businessTimeFieldId: provenance.businessTimeFieldId as string,
      scope: "principal_organization_scope",
      pushdown: "clickhouse",
      sourceTimeCoverage: provenance.sourceTimeCoverage as number | null,
      groupResultLimit: provenance.groupResultLimit as number | null,
      groupResultTruncated: provenance.groupResultTruncated,
    },
  };
}

function validateOrganizationAttribution(value: unknown): OrganizationAttributionQuality {
  if (!isRecord(value) || !isRecord(value.organizationAttribution)) {
    invalidResponse("dataQuality.organizationAttribution is required");
  }
  const quality = value.organizationAttribution;
  if (quality.status !== "not_measured" && quality.status !== "measured") {
    invalidResponse("dataQuality.organizationAttribution.status is invalid");
  }
  if (quality.basis !== "metric_identity") {
    invalidResponse("dataQuality.organizationAttribution.basis is invalid");
  }
  if (quality.coverage !== null
    && (typeof quality.coverage !== "number"
      || !Number.isFinite(quality.coverage)
      || quality.coverage < 0
      || quality.coverage > 1)) {
    invalidResponse("dataQuality.organizationAttribution.coverage is invalid");
  }
  if (quality.numerator !== null
    && (!Number.isInteger(quality.numerator) || Number(quality.numerator) < 0)) {
    invalidResponse("dataQuality.organizationAttribution.numerator is invalid");
  }
  if (quality.denominator !== null
    && (!Number.isInteger(quality.denominator) || Number(quality.denominator) < 1)) {
    invalidResponse("dataQuality.organizationAttribution.denominator is invalid");
  }
  const timeRange = validateOrganizationAttributionTimeRange(quality.timeRange);
  if (quality.topologyVersion !== null
    && (typeof quality.topologyVersion !== "string" || !quality.topologyVersion.trim())) {
    invalidResponse("dataQuality.organizationAttribution.topologyVersion is invalid");
  }
  const statistics = [
    quality.coverage,
    quality.numerator,
    quality.denominator,
    timeRange,
    quality.topologyVersion,
  ];
  if (quality.status === "not_measured" && statistics.some((item) => item !== null)) {
    invalidResponse("not_measured organization attribution cannot contain statistics");
  }
  if (quality.status === "measured") {
    if (statistics.some((item) => item === null)) {
      invalidResponse("measured organization attribution requires complete build metadata");
    }
    if (Number(quality.numerator) > Number(quality.denominator)) {
      invalidResponse("organization attribution numerator exceeds denominator");
    }
    const expected = Number(quality.numerator) / Number(quality.denominator);
    if (Math.abs(Number(quality.coverage) - expected) > 1e-12) {
      invalidResponse("organization attribution coverage does not match numerator/denominator");
    }
  }
  return {
    status: quality.status,
    coverage: quality.coverage as number | null,
    numerator: quality.numerator as number | null,
    denominator: quality.denominator as number | null,
    basis: "metric_identity",
    timeRange,
    topologyVersion: quality.topologyVersion as string | null,
  };
}

function validateOrganizationAttributionTimeRange(
  value: unknown,
): OrganizationAttributionQuality["timeRange"] {
  if (value === null) return null;
  if (!isRecord(value)
    || value.kind !== "business_month"
    || typeof value.start !== "string"
    || typeof value.end !== "string"
    || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value.start)
    || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value.end)
    || value.start > value.end) {
    invalidResponse("dataQuality.organizationAttribution.timeRange is invalid");
  }
  return { kind: "business_month", start: value.start, end: value.end };
}

function validateGroup(value: unknown, index: number): VehicleAggregateObservation["groups"][number] {
  if (!isRecord(value) || !isRecord(value.keys)) invalidResponse(`groups[${index}] is invalid`);
  if ("vehicle.dimension.organization" in value.keys) {
    invalidResponse("organization identifiers cannot be returned as group keys");
  }
  const keys: Record<string, string | number | null> = {};
  for (const [fieldId, fieldValue] of Object.entries(value.keys)) {
    if (!fieldId || (fieldValue !== null && typeof fieldValue !== "string" && typeof fieldValue !== "number")) {
      invalidResponse(`groups[${index}].keys is invalid`);
    }
    keys[fieldId] = fieldValue;
  }
  const groupValue = numericScalar(value.value, false, `groups[${index}].value`);
  return { keys, value: groupValue as Exclude<AggregateScalar, null> };
}

function numericScalar(value: unknown, nullable: boolean, field: string): AggregateScalar {
  if (value === null && nullable) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return value;
  invalidResponse(`${field} must be numeric${nullable ? " or null" : ""}`);
}

function invalidResponse(message: string): never {
  throw new Error(`VEHICLE_TOOL_RESPONSE_INVALID: ${message}`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractToolError(payload: unknown): { code: string; message: string } {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const value = error as { code?: unknown; message?: unknown };
      return {
        code: typeof value.code === "string" ? value.code : "VEHICLE_TOOL_FAILED",
        message: typeof value.message === "string" ? value.message : "Vehicle tool failed",
      };
    }
  }
  return { code: "VEHICLE_TOOL_FAILED", message: "Vehicle tool failed" };
}
