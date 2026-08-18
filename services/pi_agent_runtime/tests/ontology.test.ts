import assert from "node:assert/strict";
import test from "node:test";

import { loadRuntimeConfig } from "../src/config.js";
import { OntologyCatalog } from "../src/ontology.js";
import { createOntologyDescribeTool, createOntologySearchTool } from "../src/ontology-tool.js";
import { routeIntent, runtimeSkill, workspaceSnapshot } from "../src/workspace.js";

const catalog = OntologyCatalog.from({
  workspaceId: "vehicle-workspace",
  resourceVersion: "p18.5.0",
  entityTypes: [
    { entityTypeId: "vehicle_ontology.vehicle", name: { zhCn: "车辆" }, stereotypes: ["entity"], approvalStatus: "published", sourceTable: "demo_table", fields: [{ fieldId: "vehicle_ontology.vehicle.vehicleId", valueType: "string" }] },
    { entityTypeId: "vehicle_ontology.supplier", name: { zhCn: "供应商" }, stereotypes: ["entity"], approvalStatus: "published" },
  ],
  eventTypes: [{ eventSetId: "vehicle_analytics.event.short_rental_order", name: { zhCn: "临租车订单" }, grain: "一行代表一条订单", approvalStatus: "published" }],
  metricDefinitions: [{
    metricId: "vehicle.count.short_rental_order",
    canonicalNameZh: "临租订单数",
    aliases: [{ text: "短租订单数" }],
    aggregator: "count_distinct",
    grain: { entityTypeId: "vehicle_analytics.event.short_rental_order", description: "结果粒度为 short_rental_order。" },
    dimensions: [
      { dimensionId: "organization", entityTypeId: "vehicle_ontology.organization", fieldId: "vehicle.dimension.organization" },
      { dimensionId: "supplier", entityTypeId: "vehicle_ontology.supplier", fieldId: "vehicle.dimension.supplier" },
      { dimensionId: "vehicle", entityTypeId: "vehicle_ontology.vehicle", fieldId: "vehicle.dimension.vehicle" },
      { dimensionId: "employee", entityTypeId: "vehicle_ontology.employee", fieldId: "vehicle.dimension.employee" },
    ],
    executable: true,
    publicationStatus: "published_executable",
    fieldMappings: [
      { logicalFieldId: "short_rental.order_id", role: "identity_key", sourceType: "Nullable(String)", sourceColumn: "physical_order_key" },
      { logicalFieldId: "vehicle.dimension.organization", role: "organization_key", sourceType: "Nullable(String)", sourceColumn: "organization_id" },
      { logicalFieldId: "vehicle.dimension.supplier", role: "dimension", sourceType: "Nullable(String)", sourceColumn: "supplier_name" },
      { logicalFieldId: "vehicle.time.business_month", role: "business_time", sourceType: "Nullable(String)", sourceColumn: "business_month" },
    ],
    timeSemantics: { businessTimeFieldId: "vehicle.time.business_month", businessTimeRole: "accounting_month", timezone: "Asia/Shanghai", allowedWindow: "business_month" },
    capabilityGaps: [],
  }],
    relationTypes: [{ relationId: "relation-1", relationType: "served_by", sourceEntityTypeId: "vehicle_ontology.vehicle", targetEntityTypeId: "vehicle_ontology.supplier", direction: "forward", physicalizationMode: "schema_only", approvalStatus: "published", schemaTopologyRef: "demo_topology_ref" }],
  timeSemantics: [{ timeRoleId: "vehicle.time.business_month", role: "accounting_month", description: "业务归属月份", availability: "published", mappings: [{ eventSetId: "vehicle_analytics.event.short_rental_order", sourceColumn: "business_month" }] }],
}, {
  metrics: [{ metricId: "vehicle.count.short_rental_order", displayName: "临租订单数", grain: "short_rental_order", aggregation: "count_distinct", unit: "count" }],
});

test("ontology catalog projects only model-safe semantic metadata", () => {
  const view = catalog.view("临租", "metric");
  assert.equal(view.total, 1);
  assert.equal(view.items[0]?.id, "vehicle.count.short_rental_order");
  assert.equal(view.items[0]?.aggregation, "count_distinct");
  assert.equal(view.items[0]?.unit, "count");
  assert.equal(view.items[0]?.grain, "结果粒度为 short_rental_order。");
  assert.equal(view.items[0]?.dimensions?.find((item) => item.fieldId === "vehicle.dimension.organization")?.allowedOperations[0], "server_scope");
  assert.equal(view.items[0]?.timeSemantics?.allowedWindow, "business_month");
  assert.equal(view.items[0]?.capabilityGaps?.some((gap) => gap.code === "high_cardinality_grouping_limited"), true);
  assert.equal(catalog.view("供应商", "field").items.some((item) => item.id === "vehicle.dimension.supplier"), true);
  assert.equal(catalog.view("served_by", "relation").total, 1);
  assert.ok(catalog.counts.fields > 0);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("demo_table"), false);
  assert.equal(serialized.includes("physical_order_key"), false);
  assert.equal(serialized.includes("sourceTable"), false);
  assert.equal(serialized.includes("sourceColumn"), false);
  assert.equal(serialized.includes("demo_topology_ref"), false);
});

test("ontology tools search and describe the formal catalog", async () => {
  const search = createOntologySearchTool(catalog);
  const result = await search.execute("call-search", { query: "临租", kinds: ["metric"] }, new AbortController().signal, undefined);
  assert.equal(search.name, "ontology_search");
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /vehicle\.count\.short_rental_order/);

  const describe = createOntologyDescribeTool(catalog);
  const detail = await describe.execute("call-describe", { semanticId: "vehicle.time.business_month" }, new AbortController().signal, undefined);
  assert.match(detail.content[0]?.type === "text" ? detail.content[0].text : "", /业务归属月份/);

  const relation = await search.execute("call-relation", { query: "served_by", kinds: ["relation"] }, new AbortController().signal, undefined);
  assert.match(relation.content[0]?.type === "text" ? relation.content[0].text : "", /relation-1/);
});

test("ontology search does not hide relations after the bounded workspace page", () => {
  const relationItems = Array.from({ length: 240 }, (_, index) => ({
    relationId: `relation-${index}`,
    relationType: index === 239 ? "target_relation" : "served_by",
    sourceEntityTypeId: "vehicle_ontology.vehicle",
    targetEntityTypeId: "vehicle_ontology.supplier",
    approvalStatus: "published",
  }));
  const largeCatalog = OntologyCatalog.from({
    workspaceId: "vehicle-workspace",
    resourceVersion: "p18.5.0",
    entityTypes: [],
    eventTypes: [],
    metricDefinitions: [],
    relationTypes: relationItems,
    timeSemantics: [],
  });

  const result = largeCatalog.search("target_relation", ["relation"]);
  assert.equal(result[0]?.id, "relation-239");
});

test("workspace and intent routing report real capability status", () => {
  const config = loadRuntimeConfig({ PI_AGENT_CLICKHOUSE_STATUS: "offline" });
  const workspace = workspaceSnapshot(config, catalog);
  assert.equal(workspace.dataSources[0]?.status, "online");
  assert.equal(workspace.dataSources[1]?.status, "offline");
  assert.equal(workspace.routing.modelId, "gpt-5.6-terra");
  assert.equal(workspace.skills.length, 12);
  assert.equal(workspace.skills[0]?.id, "vehicle.management_report");
  assert.equal("executionPrompt" in (workspace.skills[0] ?? {}), false);
  assert.equal("allowedMetricIds" in (workspace.skills[0] ?? {}), false);
  assert.equal("fixedSteps" in (workspace.skills[0] ?? {}), false);
  assert.equal(routeIntent("解释临租订单数的指标定义").skillId, "ontology.semantic_exploration");
  assert.equal(routeIntent("生成 2026 年 6 月临租订单经营分析报告").skillId, "vehicle.management_report");
  assert.equal(routeIntent("查询 2026 年 6 月临租订单数").skillId, "vehicle.short_rental_analysis");
  assert.equal(
    routeIntent("补充供应商变化", { previousSkillId: "vehicle.management_report" }).skillId,
    "vehicle.management_report",
  );
  assert.equal(routeIntent("对比 2026 年 5 月和 6 月临租订单数").skillId, "vehicle.period_comparison");
  assert.equal(routeIntent("按供应商分组查询 2026 年 6 月临租订单数").skillId, "vehicle.short_rental_supplier_breakdown");
  assert.equal(routeIntent("按车牌分组查询 2026 年 6 月临租订单数").skillId, "vehicle.short_rental_vehicle_breakdown");
  assert.equal(routeIntent("按员工分组查询 2026 年 6 月临租订单数").skillId, "vehicle.short_rental_employee_breakdown");
  assert.equal(routeIntent("筛选供应商为甲公司的临租订单数").skillId, "vehicle.short_rental_filtered_analysis");
  assert.equal(routeIntent("查询供应商为甲公司的临租订单数").skillId, "vehicle.short_rental_filtered_analysis");
  assert.equal(routeIntent("和 5 月比较", { previousSkillId: "vehicle.short_rental_analysis" }).skillId, "vehicle.period_comparison");
  assert.equal(routeIntent("按供应商分组", { previousSkillId: "vehicle.short_rental_analysis" }).skillId, "vehicle.short_rental_supplier_breakdown");
  assert.equal(routeIntent("按供应商分组查询长租车辆数").skillId, "vehicle.long_rental_supplier_breakdown");
  assert.equal(routeIntent("查询 2026 年 4 月长租车辆数").skillId, "vehicle.long_rental_analysis");
  assert.equal(routeIntent("对比 2026 年 5 月和 6 月长租车辆数").skillId, "vehicle.long_rental_period_comparison");
  assert.equal(
    routeIntent("按供应商分组查询 2026 年 4 月长租和临租订单数").skillId,
    "vehicle.rental_volume_comparison",
  );
  assert.equal(
    routeIntent("按供应商分组", { previousSkillId: "vehicle.rental_volume_comparison" }).skillId,
    "vehicle.rental_volume_comparison",
  );
  assert.equal(routeIntent("比较 2026 年 4 月长租和临租费用").skillId, "free.analysis");
  assert.equal(
    routeIntent("和 5 月比较", { previousSkillId: "vehicle.long_rental_analysis" }).skillId,
    "vehicle.long_rental_period_comparison",
  );
  assert.equal(routeIntent("按车型分组查询临租订单数").skillId, "vehicle.short_rental_vehicle_breakdown");
  assert.equal(runtimeSkill("vehicle.short_rental_vehicle_breakdown").status, "limited");
  assert.deepEqual(runtimeSkill("vehicle.short_rental_vehicle_breakdown").toolNames, ["ontology_search", "ontology_describe"]);
  assert.deepEqual(runtimeSkill("free.analysis").toolNames, ["ontology_search", "ontology_describe"]);
  assert.equal(routeIntent("你好").matched, false);
});
