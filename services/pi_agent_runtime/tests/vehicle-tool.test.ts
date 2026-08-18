import assert from "node:assert/strict";
import test from "node:test";

import { loadRuntimeConfig } from "../src/config.js";
import {
  createVehicleAggregateTool,
  validateVehicleAggregateObservation,
  VEHICLE_AGGREGATE_ENDPOINT,
  VEHICLE_AGGREGATE_TOOL_NAME,
} from "../src/vehicle-tool.js";

const validObservation = {
  metricId: "vehicle.count.short_rental_order",
  label: "临租订单数",
  value: "42",
  unit: "单",
  time: { kind: "business_month", value: "2026-06" },
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
};

test("vehicle tool forwards only semantic inputs and the authenticated cookie", async () => {
  let captured: Request | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    captured = new Request(input, init);
    return new Response(
      JSON.stringify(validObservation),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const tool = createVehicleAggregateTool(
    loadRuntimeConfig({ PI_AGENT_TOOL_API_URL: "http://127.0.0.1:8090" }),
    "r6_refresh=session-cookie",
    fakeFetch,
  );

  const result = await tool.execute(
    "call-1",
    {
      metricId: "vehicle.count.short_rental_order",
      time: { kind: "business_month", value: "2026-06" },
      groupByFieldIds: [],
      filters: [],
    },
    new AbortController().signal,
    undefined,
  );

  assert.equal(tool.name, VEHICLE_AGGREGATE_TOOL_NAME);
  assert.match(tool.name, /^[a-zA-Z0-9_-]+$/);
  assert.ok(captured);
  assert.equal(new URL(captured.url).pathname, VEHICLE_AGGREGATE_ENDPOINT);
  assert.equal(captured.headers.get("cookie"), "r6_refresh=session-cookie");
  const body = await captured.json();
  assert.deepEqual(body, {
    metricId: "vehicle.count.short_rental_order",
    time: { kind: "business_month", value: "2026-06" },
    groupByFieldIds: [],
    filters: [],
  });
  assert.equal(JSON.stringify(body).includes("organization"), false);
  assert.equal(result.content[0]?.type, "text");
  assert.deepEqual(result.details, { observation: validObservation });
});

test("vehicle tool rejects an incomplete HTTP 200 response", async () => {
  const tool = createVehicleAggregateTool(
    loadRuntimeConfig({ PI_AGENT_TOOL_API_URL: "http://127.0.0.1:8090" }),
    "r6_refresh=session-cookie",
    async () => new Response(JSON.stringify({ metricId: validObservation.metricId, value: 42, unit: "单" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await assert.rejects(
    tool.execute("call-invalid", {
      metricId: validObservation.metricId,
      time: { kind: "business_month", value: "2026-06" },
      groupByFieldIds: [],
      filters: [],
    }, new AbortController().signal, undefined),
    /VEHICLE_TOOL_RESPONSE_INVALID/,
  );
});

test("vehicle tool rejects the legacy flat organization coverage contract", async () => {
  const legacy = {
    ...validObservation,
    provenance: {
      ...validObservation.provenance,
      organizationAttributionCoverage: 1,
    },
  };
  const tool = createVehicleAggregateTool(
    loadRuntimeConfig({ PI_AGENT_TOOL_API_URL: "http://127.0.0.1:8090" }),
    "r6_refresh=session-cookie",
    async () => new Response(JSON.stringify(legacy), { status: 200, headers: { "content-type": "application/json" } }),
  );
  await assert.rejects(
    tool.execute("call-legacy", {
      metricId: validObservation.metricId,
      time: { kind: "business_month", value: "2026-06" },
      groupByFieldIds: [],
      filters: [],
    }, new AbortController().signal, undefined),
    /VEHICLE_TOOL_RESPONSE_INVALID/,
  );
});

test("vehicle tool accepts complete build-time organization quality metadata", () => {
  const measured = {
    ...validObservation,
    dataQuality: {
      organizationAttribution: {
        status: "measured",
        coverage: 0.75,
        numerator: 3,
        denominator: 4,
        basis: "metric_identity",
        timeRange: { kind: "business_month", start: "2026-01", end: "2026-06" },
        topologyVersion: "p18-topology-test",
      },
    },
  };

  assert.deepEqual(validateVehicleAggregateObservation(measured), measured);
});

test("vehicle tool rejects organization identifiers in grouped observations", async () => {
  const unsafe = {
    ...validObservation,
    value: null,
    groups: [{ keys: { "vehicle.dimension.organization": "real-org-id" }, value: 1 }],
    provenance: { ...validObservation.provenance, groupResultLimit: 200 },
  };
  const tool = createVehicleAggregateTool(
    loadRuntimeConfig({ PI_AGENT_TOOL_API_URL: "http://127.0.0.1:8090" }),
    "r6_refresh=session-cookie",
    async () => new Response(JSON.stringify(unsafe), { status: 200, headers: { "content-type": "application/json" } }),
  );
  await assert.rejects(
    tool.execute("call-unsafe", {
      metricId: validObservation.metricId,
      time: { kind: "business_month", value: "2026-06" },
      groupByFieldIds: ["vehicle.dimension.organization"],
      filters: [],
    }, new AbortController().signal, undefined),
    /organization identifiers cannot be returned/,
  );
});

test("vehicle tool enforces the active Skill metric allowlist before HTTP", async () => {
  let called = false;
  const tool = createVehicleAggregateTool(
    loadRuntimeConfig({ PI_AGENT_TOOL_API_URL: "http://127.0.0.1:8090" }),
    "r6_refresh=session-cookie",
    async () => {
      called = true;
      return new Response(JSON.stringify(validObservation), { status: 200 });
    },
    ["vehicle.count.long_rental_vehicle"],
  );

  await assert.rejects(
    tool.execute("call-outside-skill", {
      metricId: "vehicle.count.short_rental_order",
      time: { kind: "business_month", value: "2026-06" },
      groupByFieldIds: [],
      filters: [],
    }, new AbortController().signal, undefined),
    /VEHICLE_TOOL_METRIC_NOT_ALLOWED/,
  );
  assert.equal(called, false);
});
