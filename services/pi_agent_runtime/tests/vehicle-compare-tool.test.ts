import assert from "node:assert/strict";
import test from "node:test";

import { loadRuntimeConfig } from "../src/config.js";
import {
  createVehicleCompareTool,
  validateVehicleCompareObservation,
  VEHICLE_COMPARE_ENDPOINT,
  VEHICLE_COMPARE_TOOL_NAME,
} from "../src/vehicle-compare-tool.js";

function aggregate(value: number, month: string) {
  return {
    metricId: "vehicle.count.short_rental_order",
    label: "临租订单数",
    value,
    unit: "单",
    time: { kind: "business_month", value: month },
    groups: [],
    completeness: "complete",
    dataQuality: {
      organizationAttribution: {
        status: "not_measured",
        coverage: null,
        numerator: null,
        denominator: null,
        basis: "metric_identity",
        timeRange: null,
        topologyVersion: null,
      },
    },
    provenance: {
      sourceId: "vehicle.mount.short_rental_orders_global",
      aggregation: "count_distinct",
      identityFieldId: "short_rental.order_id",
      organizationFieldId: "vehicle.dimension.organization",
      businessTimeFieldId: "vehicle.time.business_month",
      scope: "principal_organization_scope",
      pushdown: "clickhouse",
      sourceTimeCoverage: 0.9989,
      groupResultLimit: null,
      groupResultTruncated: false,
    },
  } as const;
}

const validComparison = {
  metricId: "vehicle.count.short_rental_order",
  label: "临租订单数",
  unit: "单",
  current: aggregate(100, "2026-06"),
  baseline: aggregate(80, "2026-05"),
  change: {
    absoluteChange: 20,
    percentChange: 25,
    direction: "increase",
    status: "computed",
  },
  groups: [],
  completeness: "complete",
  provenance: {
    calculation: "period_over_period",
    comparisonBasis: "same_metric_same_principal_scope_same_filters",
    groupResultLimit: null,
    groupResultTruncated: false,
  },
} as const;

test("vehicle compare forwards semantic periods without organization scope", async () => {
  let captured: Request | undefined;
  const tool = createVehicleCompareTool(
    loadRuntimeConfig({ PI_AGENT_TOOL_API_URL: "http://127.0.0.1:8090" }),
    "r6_refresh=session-cookie",
    async (input, init) => {
      captured = new Request(input, init);
      return new Response(JSON.stringify(validComparison), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    ["vehicle.count.short_rental_order"],
  );

  const result = await tool.execute("compare-1", {
    metricId: "vehicle.count.short_rental_order",
    currentTime: { kind: "business_month", value: "2026-06" },
    baselineTime: { kind: "business_month", value: "2026-05" },
    groupByFieldIds: [],
    filters: [],
  }, new AbortController().signal, undefined);

  assert.equal(tool.name, VEHICLE_COMPARE_TOOL_NAME);
  assert.ok(captured);
  assert.equal(new URL(captured.url).pathname, VEHICLE_COMPARE_ENDPOINT);
  assert.equal(captured.headers.get("cookie"), "r6_refresh=session-cookie");
  const body = await captured.json();
  assert.equal(JSON.stringify(body).includes("organization"), false);
  assert.deepEqual(result.details, { comparison: validComparison });
});

test("vehicle compare validates periods and structured response", async () => {
  assert.deepEqual(validateVehicleCompareObservation(validComparison), validComparison);
  assert.throws(
    () => validateVehicleCompareObservation({
      ...validComparison,
      completeness: "partial",
    }),
    /VEHICLE_COMPARE_RESPONSE_INVALID/,
  );

  const tool = createVehicleCompareTool(
    loadRuntimeConfig({ PI_AGENT_TOOL_API_URL: "http://127.0.0.1:8090" }),
    "",
    async () => new Response(JSON.stringify(validComparison), { status: 200 }),
  );
  await assert.rejects(
    tool.execute("compare-same-period", {
      metricId: validComparison.metricId,
      currentTime: { kind: "business_month", value: "2026-06" },
      baselineTime: { kind: "business_month", value: "2026-06" },
      groupByFieldIds: [],
      filters: [],
    }, new AbortController().signal, undefined),
    /VEHICLE_COMPARE_PERIOD_INVALID/,
  );
});

test("vehicle compare rejects organization identifiers in group changes", () => {
  const grouped = {
    ...validComparison,
    current: {
      ...validComparison.current,
      value: null,
      groups: [{ keys: { "vehicle.dimension.supplier": "供应商 A" }, value: 10 }],
      provenance: { ...validComparison.current.provenance, groupResultLimit: 200 },
    },
    baseline: {
      ...validComparison.baseline,
      value: null,
      groups: [{ keys: { "vehicle.dimension.supplier": "供应商 A" }, value: 8 }],
      provenance: { ...validComparison.baseline.provenance, groupResultLimit: 200 },
    },
    change: null,
    groups: [{
      keys: { "vehicle.dimension.organization": "real-org-id" },
      currentValue: 10,
      baselineValue: 8,
      change: { absoluteChange: 2, percentChange: 25, direction: "increase", status: "computed" },
    }],
    provenance: { ...validComparison.provenance, groupResultLimit: 200 },
  };

  assert.throws(
    () => validateVehicleCompareObservation(grouped),
    /organization identifiers cannot be returned/,
  );
});
