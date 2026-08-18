import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { RuntimeConfig } from "./config.js";
import {
  validateVehicleAggregateObservation,
  type AggregateScalar,
  type VehicleAggregateObservation,
} from "./vehicle-tool.js";

export const VEHICLE_COMPARE_TOOL_NAME = "vehicle_compare";
export const VEHICLE_COMPARE_ENDPOINT = "/tools/vehicle.compare";

export interface PeriodChange {
  absoluteChange: Exclude<AggregateScalar, null>;
  percentChange: number | null;
  direction: "increase" | "decrease" | "unchanged";
  status: "computed" | "baseline_zero";
}

export interface VehicleCompareObservation {
  metricId: string;
  label: string;
  unit: string;
  current: VehicleAggregateObservation;
  baseline: VehicleAggregateObservation;
  change: PeriodChange | null;
  groups: Array<{
    keys: Record<string, string | number | null>;
    currentValue: Exclude<AggregateScalar, null>;
    baselineValue: Exclude<AggregateScalar, null>;
    change: PeriodChange;
  }>;
  completeness: "complete" | "partial";
  provenance: {
    calculation: "period_over_period";
    comparisonBasis: "same_metric_same_principal_scope_same_filters";
    groupResultLimit: number | null;
    groupResultTruncated: boolean;
  };
}

const BusinessMonthInput = Type.Object(
  {
    kind: Type.Literal("business_month"),
    value: Type.String({ pattern: "^[0-9]{4}-(0[1-9]|1[0-2])$" }),
  },
  { additionalProperties: false },
);

const VehicleCompareInput = Type.Object(
  {
    metricId: Type.String({ minLength: 1, maxLength: 160 }),
    currentTime: BusinessMonthInput,
    baselineTime: BusinessMonthInput,
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

export function createVehicleCompareTool(
  config: RuntimeConfig,
  cookie: string,
  fetchImpl: typeof fetch = fetch,
  allowedMetricIds?: readonly string[],
): AgentTool<typeof VehicleCompareInput> {
  const metricAllowlist = allowedMetricIds ? new Set(allowedMetricIds) : undefined;
  const metricDescription = allowedMetricIds?.length
    ? ` 当前 Skill 只允许：${allowedMetricIds.join(", ")}。`
    : "";
  return {
    name: VEHICLE_COMPARE_TOOL_NAME,
    label: "车辆指标周期比较",
    description:
      `对同一正式指标、同一 Principal 范围和同一过滤条件执行两个业务月份的受治理比较。变化值和变化率由服务端确定性计算。${metricDescription}`,
    parameters: VehicleCompareInput,
    executionMode: "sequential",
    execute: async (_toolCallId, parameters, signal) => {
      if (metricAllowlist && !metricAllowlist.has(parameters.metricId)) {
        throw new Error(
          `VEHICLE_TOOL_METRIC_NOT_ALLOWED: Metric ${parameters.metricId} is not allowed by the active Skill`,
        );
      }
      if (parameters.currentTime.value === parameters.baselineTime.value) {
        throw new Error("VEHICLE_COMPARE_PERIOD_INVALID: currentTime and baselineTime must differ");
      }
      const response = await fetchImpl(`${config.agentApiUrl}${VEHICLE_COMPARE_ENDPOINT}`, {
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
        throw new Error("VEHICLE_COMPARE_RESPONSE_INVALID: Vehicle compare tool returned invalid JSON");
      }
      if (!response.ok) {
        const error = extractToolError(payload);
        throw new Error(`${error.code}: ${error.message}`);
      }
      const comparison = validateVehicleCompareObservation(payload);
      if (comparison.metricId !== parameters.metricId
        || comparison.current.time.value !== parameters.currentTime.value
        || comparison.baseline.time.value !== parameters.baselineTime.value) {
        invalidResponse("response does not match the requested metric and periods");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(comparison) }],
        details: { comparison },
      };
    },
  };
}

export function validateVehicleCompareObservation(payload: unknown): VehicleCompareObservation {
  if (!isRecord(payload)) invalidResponse("response must be an object");
  const current = validateVehicleAggregateObservation(payload.current);
  const baseline = validateVehicleAggregateObservation(payload.baseline);
  if (typeof payload.metricId !== "string" || !payload.metricId.trim()
    || typeof payload.label !== "string" || !payload.label.trim()
    || typeof payload.unit !== "string" || !payload.unit.trim()) {
    invalidResponse("metricId, label, and unit are required");
  }
  if (payload.metricId !== current.metricId || payload.metricId !== baseline.metricId
    || payload.label !== current.label || payload.label !== baseline.label
    || payload.unit !== current.unit || payload.unit !== baseline.unit) {
    invalidResponse("current and baseline observations are not compatible");
  }
  if (current.time.value === baseline.time.value) invalidResponse("comparison periods must differ");
  if (!Array.isArray(payload.groups)) invalidResponse("groups must be an array");
  const groups = payload.groups.map((item, index) => validateCompareGroup(item, index));
  if (payload.completeness !== "complete" && payload.completeness !== "partial") {
    invalidResponse("completeness is invalid");
  }
  if (!isRecord(payload.provenance)
    || payload.provenance.calculation !== "period_over_period"
    || payload.provenance.comparisonBasis !== "same_metric_same_principal_scope_same_filters"
    || typeof payload.provenance.groupResultTruncated !== "boolean") {
    invalidResponse("provenance governance markers are invalid");
  }
  const groupResultLimit = payload.provenance.groupResultLimit;
  if (groupResultLimit !== null
    && (!Number.isInteger(groupResultLimit) || Number(groupResultLimit) < 1)) {
    invalidResponse("provenance.groupResultLimit is invalid");
  }
  const grouped = groupResultLimit !== null;
  const change = payload.change === null ? null : validateChange(payload.change, "change");
  if (grouped && change !== null) invalidResponse("grouped comparisons cannot have a top-level change");
  if (!grouped && change === null) invalidResponse("ungrouped comparisons require a top-level change");
  if (!grouped && groups.length) invalidResponse("ungrouped comparisons cannot contain groups");
  const shouldBePartial = current.completeness === "partial"
    || baseline.completeness === "partial"
    || payload.provenance.groupResultTruncated;
  if (payload.completeness !== (shouldBePartial ? "partial" : "complete")) {
    invalidResponse("completeness does not match source observations and truncation");
  }
  return {
    metricId: payload.metricId,
    label: payload.label,
    unit: payload.unit,
    current,
    baseline,
    change,
    groups,
    completeness: payload.completeness,
    provenance: {
      calculation: "period_over_period",
      comparisonBasis: "same_metric_same_principal_scope_same_filters",
      groupResultLimit: groupResultLimit as number | null,
      groupResultTruncated: payload.provenance.groupResultTruncated,
    },
  };
}

function validateCompareGroup(
  value: unknown,
  index: number,
): VehicleCompareObservation["groups"][number] {
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
  return {
    keys,
    currentValue: numericScalar(value.currentValue, `groups[${index}].currentValue`),
    baselineValue: numericScalar(value.baselineValue, `groups[${index}].baselineValue`),
    change: validateChange(value.change, `groups[${index}].change`),
  };
}

function validateChange(value: unknown, field: string): PeriodChange {
  if (!isRecord(value)) invalidResponse(`${field} is invalid`);
  const absoluteChange = numericScalar(value.absoluteChange, `${field}.absoluteChange`);
  if (value.percentChange !== null
    && (typeof value.percentChange !== "number" || !Number.isFinite(value.percentChange))) {
    invalidResponse(`${field}.percentChange is invalid`);
  }
  if (!new Set(["increase", "decrease", "unchanged"]).has(String(value.direction))) {
    invalidResponse(`${field}.direction is invalid`);
  }
  if (value.status !== "computed" && value.status !== "baseline_zero") {
    invalidResponse(`${field}.status is invalid`);
  }
  if ((value.status === "computed" && value.percentChange === null)
    || (value.status === "baseline_zero" && value.percentChange !== null)) {
    invalidResponse(`${field}.status does not match percentChange`);
  }
  return {
    absoluteChange,
    percentChange: value.percentChange as number | null,
    direction: value.direction as PeriodChange["direction"],
    status: value.status,
  };
}

function numericScalar(value: unknown, field: string): Exclude<AggregateScalar, null> {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return value;
  invalidResponse(`${field} must be numeric`);
}

function invalidResponse(message: string): never {
  throw new Error(`VEHICLE_COMPARE_RESPONSE_INVALID: ${message}`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractToolError(payload: unknown): { code: string; message: string } {
  if (isRecord(payload)) {
    const error = payload.error;
    if (isRecord(error)) {
      return {
        code: typeof error.code === "string" ? error.code : "VEHICLE_COMPARE_FAILED",
        message: typeof error.message === "string" ? error.message : "Vehicle comparison failed",
      };
    }
  }
  return { code: "VEHICLE_COMPARE_FAILED", message: "Vehicle comparison failed" };
}
