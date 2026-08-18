import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const demoAsset = (name: string) => fileURLToPath(new URL(`../../../docs/assets/demo/${name}`, import.meta.url));

const threadId = "11111111-1111-4111-8111-111111111111";

type ThreadState = {
  schemaVersion: "pi-thread.v1";
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "running" | "failed";
  archivedAt?: string;
  pinnedAt?: string;
  messages: unknown[];
  events: unknown[];
};

async function mockPiWorkbench(page: Page, resultMode: false | "aggregate" | "comparison" = false) {
  let thread: ThreadState | null = null;
  await page.route("**/auth/me", (route) => route.fulfill({ json: {
    id: "principal-browser-test",
    email: "browser@example.test",
    displayName: "浏览器测试用户",
    permissions: [],
    dataScope: "organization",
  } }));
  await page.route("**/pi-agent/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/pi-agent/, "");
    if (path === "/config") return route.fulfill({ json: {
      runtime: "pi-agent-core",
      provider: "openai-compatible",
      modelId: "gpt-5.6-terra",
      modelName: "GPT-5.6 Terra",
      thinkingLevel: "high",
      reasoningEnabled: true,
      keyConfigured: true,
      persistence: "local-json",
    } });
    if (path === "/workspace") return route.fulfill({ json: {
      schemaVersion: "pi-workspace.v1",
      skills: [
        { id: "vehicle.management_report", label: "车辆经营分析报告", summary: "主动分析 · 周期比较与驱动拆解", status: "available", prompt: "生成 2026 年 6 月临租订单经营分析报告", toolNames: ["ontology_search", "ontology_describe", "vehicle_aggregate", "vehicle_compare"] },
        { id: "vehicle.short_rental_analysis", label: "临租订单分析", summary: "自动调用 · 受治理聚合", status: "available", prompt: "查询 2026 年 6 月的临租订单数", toolNames: ["ontology_search", "ontology_describe", "vehicle_aggregate"] },
        { id: "vehicle.long_rental_analysis", label: "长租车辆分析", summary: "自动调用 · 受治理车辆聚合", status: "available", prompt: "查询 2026 年 6 月的长租车辆数", toolNames: ["ontology_search", "ontology_describe", "vehicle_aggregate"] },
        { id: "vehicle.rental_volume_comparison", label: "长短租业务量对照", summary: "自动调用 · 异粒度双指标", status: "available", prompt: "按供应商分组查询 2026 年 4 月长租和临租业务量", toolNames: ["ontology_search", "ontology_describe", "vehicle_aggregate"] },
        { id: "ontology.semantic_exploration", label: "Ontology 语义检索", summary: "自动调用 · 正式语义索引", status: "available", prompt: "临租订单数的正式指标定义和时间口径是什么？", toolNames: ["ontology_search", "ontology_describe"] },
        { id: "vehicle.period_comparison", label: "车辆指标对比", summary: "自动调用 · 双周期聚合", status: "available", prompt: "对比 2026 年 5 月和 6 月的临租订单数", toolNames: ["ontology_search", "ontology_describe", "vehicle_aggregate"] },
        { id: "vehicle.long_rental_period_comparison", label: "长租车辆周期对比", summary: "自动调用 · 双周期车辆聚合", status: "available", prompt: "对比 2026 年 5 月和 6 月的长租车辆数", toolNames: ["ontology_search", "ontology_describe", "vehicle_aggregate"] },
        { id: "vehicle.short_rental_supplier_breakdown", label: "临租供应商分组", summary: "自动调用 · 供应商维度聚合", status: "available", prompt: "按供应商分组查询 2026 年 6 月临租订单数", toolNames: ["ontology_search", "ontology_describe", "vehicle_aggregate"] },
        { id: "vehicle.long_rental_supplier_breakdown", label: "长租供应商分组", summary: "自动调用 · 供应商维度车辆聚合", status: "available", prompt: "按供应商分组查询 2026 年 6 月长租车辆数", toolNames: ["ontology_search", "ontology_describe", "vehicle_aggregate"] },
        { id: "vehicle.short_rental_vehicle_breakdown", label: "临租车辆分组", summary: "语义可见 · 分组策略待发布", status: "limited", prompt: "按车辆分组查询 2026 年 6 月临租订单数", toolNames: ["ontology_search", "ontology_describe"] },
        { id: "vehicle.short_rental_employee_breakdown", label: "临租员工分组", summary: "语义可见 · 分组策略待发布", status: "limited", prompt: "按员工分组查询 2026 年 6 月临租订单数", toolNames: ["ontology_search", "ontology_describe"] },
        { id: "vehicle.short_rental_filtered_analysis", label: "临租条件筛选", summary: "自动调用 · 受治理条件过滤", status: "available", prompt: "查询 2026 年 6 月供应商为指定供应商的临租订单数", toolNames: ["ontology_search", "ontology_describe", "vehicle_aggregate"] },
      ],
      dataSources: [
        { id: "vehicle.ontology", label: "Ontology 语义层", description: "2 指标 · 4 实体", kind: "semantic", status: "online", readOnly: true, href: "/agent/ontology" },
        { id: "vehicle.clickhouse", label: "车辆数据仓库", description: "合成只读数据已加载", kind: "database", status: "online", readOnly: true, href: "/agent/workspace" },
      ],
      ontology: { workspaceId: "vehicle-demo", resourceVersion: "demo-1.0.0", counts: { entities: 4, events: 2, fields: 7, metrics: 2, relations: 2, timeSemantics: 1 } },
      routing: { mode: "automatic", fallback: "free_analysis", modelId: "gpt-5.6-terra", thinkingLevel: "high" },
    } });
    if (path === "/ontology") return route.fulfill({ json: {
      schemaVersion: "pi-ontology-view.v1",
      workspaceId: "vehicle-demo",
      resourceVersion: "demo-1.0.0",
      counts: { entities: 4, events: 2, fields: 7, metrics: 2, relations: 2, timeSemantics: 1 },
      items: [{ id: "vehicle.count.short_rental_order", kind: "metric", label: "临租订单数", description: "正式临租订单指标", status: "published_executable", executable: true, aggregation: "count_distinct", unit: "count", grain: "结果粒度为 short_rental_order。", dimensions: [{ fieldId: "vehicle.dimension.supplier", label: "供应商", allowedOperations: ["filter", "group_by"] }], timeSemantics: { businessTimeFieldId: "vehicle.time.business_month", allowedWindow: "business_month" }, allowedOperations: ["describe", "aggregate"] }],
      total: 1,
    } });
    if (path === "/threads" && request.method() === "GET") {
      const state = new URL(request.url()).searchParams.get("state") || "active";
      const included = thread && (state === "archived" ? Boolean(thread.archivedAt) : !thread.archivedAt);
      return route.fulfill({ json: included && thread ? [{ ...thread, messages: undefined, events: undefined, messageCount: thread.messages.length, eventCount: thread.events.length }] : [] });
    }
    if (path === "/threads" && request.method() === "POST") {
      const body = request.postDataJSON() as { title?: string };
      const now = "2026-08-15T02:00:00.000Z";
      thread = { schemaVersion: "pi-thread.v1", id: threadId, title: body.title || "新的会话", createdAt: now, updatedAt: now, status: "idle", messages: [], events: [] };
      return route.fulfill({ status: 201, json: thread });
    }
    if (path === `/threads/${threadId}` && request.method() === "GET" && thread) return route.fulfill({ json: thread });
    if (path === `/threads/${threadId}` && request.method() === "PATCH" && thread) {
      const update = request.postDataJSON() as { archived?: boolean; pinned?: boolean; title?: string };
      if (typeof update.archived === "boolean") {
        if (update.archived) {
          thread.archivedAt = "2026-08-15T02:05:00.000Z";
          delete thread.pinnedAt;
        } else delete thread.archivedAt;
      }
      if (typeof update.pinned === "boolean") {
        if (update.pinned) thread.pinnedAt = "2026-08-15T02:05:00.000Z";
        else delete thread.pinnedAt;
      }
      if (typeof update.title === "string") thread.title = update.title.trim();
      thread.updatedAt = "2026-08-15T02:05:00.000Z";
      return route.fulfill({ json: thread });
    }
    if (path === `/threads/${threadId}` && request.method() === "DELETE" && thread) {
      thread = null;
      return route.fulfill({ status: 204, body: "" });
    }
    if (path === `/threads/${threadId}/messages` && request.method() === "POST" && thread) {
      const content = (request.postDataJSON() as { content: string }).content;
      const aggregateObservation = (value: number | null, timeValue: string, groups: Array<{ keys: Record<string, string>; value: number }> = []) => ({
        metricId: "vehicle.count.short_rental_order",
        label: "临租订单数",
        value,
        unit: "单",
        time: { kind: "business_month", value: timeValue },
        groups,
        completeness: "complete",
        dataQuality: {
          organizationAttribution: {
            status: "measured",
            coverage: 1,
            numerator: 25,
            denominator: 25,
            basis: "metric_identity",
            timeRange: { kind: "business_month", start: "2026-05", end: "2026-06" },
            topologyVersion: "demo-topology-v1",
          },
        },
        provenance: {
          sourceId: "vehicle.mount.short_rental_orders_demo",
          aggregation: "count_distinct",
          identityFieldId: "short_rental.order_id",
          organizationFieldId: "vehicle.dimension.organization",
          businessTimeFieldId: "vehicle.time.business_month",
          scope: "principal_organization_scope",
          pushdown: "clickhouse",
          sourceTimeCoverage: 1,
          groupResultLimit: null,
          groupResultTruncated: false,
        },
      } as const);
      const observation = resultMode === "aggregate" ? aggregateObservation(11, "2026-06") : undefined;
      const totalComparison = resultMode === "comparison" ? {
        metricId: "vehicle.count.short_rental_order",
        label: "临租订单数",
        unit: "单",
        current: aggregateObservation(11, "2026-06"),
        baseline: aggregateObservation(8, "2026-05"),
        change: { absoluteChange: 3, percentChange: 37.5, direction: "increase", status: "computed" },
        groups: [],
        completeness: "complete",
        provenance: { calculation: "period_over_period", comparisonBasis: "same_metric_same_principal_scope_same_filters", groupResultLimit: null, groupResultTruncated: false },
      } as const : undefined;
      const supplierComparison = resultMode === "comparison" ? {
        metricId: "vehicle.count.short_rental_order",
        label: "临租订单数",
        unit: "单",
        current: aggregateObservation(null, "2026-06", [
          { keys: { "vehicle.dimension.supplier": "演示供应商 A" }, value: 5 },
          { keys: { "vehicle.dimension.supplier": "演示供应商 B" }, value: 3 },
          { keys: { "vehicle.dimension.supplier": "演示供应商 C" }, value: 3 },
        ]),
        baseline: aggregateObservation(null, "2026-05", [
          { keys: { "vehicle.dimension.supplier": "演示供应商 A" }, value: 3 },
          { keys: { "vehicle.dimension.supplier": "演示供应商 B" }, value: 2 },
          { keys: { "vehicle.dimension.supplier": "演示供应商 C" }, value: 3 },
        ]),
        change: null,
        groups: [
          { keys: { "vehicle.dimension.supplier": "演示供应商 A" }, currentValue: 5, baselineValue: 3, change: { absoluteChange: 2, percentChange: 66.6667, direction: "increase", status: "computed" } },
          { keys: { "vehicle.dimension.supplier": "演示供应商 B" }, currentValue: 3, baselineValue: 2, change: { absoluteChange: 1, percentChange: 50, direction: "increase", status: "computed" } },
          { keys: { "vehicle.dimension.supplier": "演示供应商 C" }, currentValue: 3, baselineValue: 3, change: { absoluteChange: 0, percentChange: 0, direction: "unchanged", status: "computed" } },
        ],
        completeness: "complete",
        provenance: { calculation: "period_over_period", comparisonBasis: "same_metric_same_principal_scope_same_filters", groupResultLimit: 200, groupResultTruncated: false },
      } as const : undefined;
      const report = "# 2026 年 6 月临租订单经营分析报告\n\n## 执行摘要\n\n临租订单数较 5 月增加 **3 单**，增幅 **37.5%**。\n\n## 核心指标\n\n| 报告期 | 订单数 |\n| --- | ---: |\n| 2026 年 6 月 | 11 单 |\n| 2026 年 5 月 | 8 单 |\n\n## 供应商变化贡献\n\n演示供应商 A 贡献了主要增量。该结论只描述结构变化，不代表因果归因。\n\n## 管理建议\n\n建议复核主要增量供应商的履约质量。\n\n## 口径与数据质量\n\n同一正式指标、同一登录范围，查询完整执行；演示数据组织归属覆盖率为 100%。";
      thread.messages = resultMode === "comparison" && totalComparison && supplierComparison ? [
        { role: "user", content },
        { role: "toolResult", toolCallId: "call-total-compare", toolName: "vehicle_compare", content: [{ type: "text", text: JSON.stringify(totalComparison) }], details: { comparison: totalComparison }, isError: false },
        { role: "toolResult", toolCallId: "call-supplier-compare", toolName: "vehicle_compare", content: [{ type: "text", text: JSON.stringify(supplierComparison) }], details: { comparison: supplierComparison }, isError: false },
        { role: "assistant", content: [{ type: "text", text: `<thinking>Analyze governed comparisons</thinking>\n${report}` }] },
      ] : [
        { role: "user", content },
        ...(observation ? [{ role: "toolResult", toolCallId: "call-browser-test", toolName: "vehicle_aggregate", content: [{ type: "text", text: JSON.stringify(observation) }], details: { observation }, isError: false }] : []),
        { role: "assistant", content: [{ type: "text", text: observation ? "<thinking>Executing governed aggregate</thinking>\n已返回受治理聚合结果。" : "当前数据连接不可用，因此不能返回订单数。" }] },
      ];
      thread.events = resultMode === "comparison" ? [
        { sequence: 1, type: "intent_routed", at: "2026-08-15T02:00:01.000Z", skillId: "vehicle.management_report", label: "车辆经营分析报告", status: "matched" },
        { sequence: 2, type: "skill_loaded", at: "2026-08-15T02:00:01.000Z", skillId: "vehicle.management_report", label: "车辆经营分析报告", status: "loaded" },
        { sequence: 3, type: "run_started", at: "2026-08-15T02:00:01.000Z", status: "running" },
        { sequence: 4, type: "tool_execution_start", at: "2026-08-15T02:00:02.000Z", toolName: "vehicle_compare", status: "running" },
        { sequence: 5, type: "tool_execution_end", at: "2026-08-15T02:00:03.000Z", toolName: "vehicle_compare", status: "completed" },
        { sequence: 6, type: "tool_execution_start", at: "2026-08-15T02:00:03.000Z", toolName: "vehicle_compare", status: "running" },
        { sequence: 7, type: "tool_execution_end", at: "2026-08-15T02:00:04.000Z", toolName: "vehicle_compare", status: "completed" },
        { sequence: 8, type: "run_completed", at: "2026-08-15T02:00:05.000Z", status: "completed" },
      ] : [
        { sequence: 1, type: "intent_routed", at: "2026-08-15T02:00:01.000Z", skillId: "vehicle.short_rental_analysis", label: "临租订单分析", status: "matched" },
        { sequence: 2, type: "run_started", at: "2026-08-15T02:00:01.000Z", status: "running" },
        { sequence: 3, type: "tool_execution_start", at: "2026-08-15T02:00:02.000Z", toolName: "vehicle_aggregate", status: "running" },
        { sequence: 4, type: "tool_execution_end", at: "2026-08-15T02:00:03.000Z", toolName: "vehicle_aggregate", status: "failed" },
        { sequence: 5, type: "run_completed", at: "2026-08-15T02:00:04.000Z", status: "completed" },
      ];
      thread.updatedAt = "2026-08-15T02:00:04.000Z";
      return route.fulfill({ json: { threadId, runId: "run-browser-test", status: "completed", answer: "当前数据连接不可用，因此不能返回订单数。", events: thread.events } });
    }
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "not found" } } });
  });
}

test("OntoFleet thread sends, renders, and recovers without inventing a value", async ({ page, context }) => {
  await context.addCookies([{ name: "r6_csrf", value: "csrf-browser-test", url: "http://127.0.0.1:5197" }]);
  await mockPiWorkbench(page);
  await page.goto("/agent");
  await expect(page.getByRole("heading", { name: "车域智析" })).toBeVisible();
  await expect(page.getByText("Pi Agent", { exact: true })).toHaveCount(0);
  await expect(page.getByText("自动识别意图", { exact: true })).toBeVisible();
  await expect(page.getByText("匹配时加载 Skill，否则自由分析")).toBeVisible();
  await expect(page.getByText("车域智析 · 自动路由 · gpt-5.6-terra")).toBeVisible();
  await expect(page.getByText("旧版分析")).toHaveCount(0);

  await expect(page.getByRole("link", { name: "Skills" })).toBeVisible();
  await page.getByRole("link", { name: "Skills" }).click();
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /使用 临租订单分析/ }).click();
  await page.getByRole("button", { name: "发送问题" }).click();

  await expect(page).toHaveURL(`/agent/${threadId}`);
  await expect(page.getByText("当前数据连接不可用，因此不能返回订单数。")).toBeVisible();
  await expect(page.getByText(/真实订单数为\s*\d+/)).toHaveCount(0);
  await page.getByText("工具活动与路由记录").click();
  await expect(page.locator(".document-events").getByText("已匹配 临租订单分析")).toBeVisible();
  await expect(page.locator(".document-events").getByText("vehicle.aggregate 失败")).toBeVisible();

  await page.reload();
  await expect(page.getByText("当前数据连接不可用，因此不能返回订单数。")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});

test("Workbench renders the persisted structured observation after refresh", async ({ page }) => {
  await mockPiWorkbench(page, "aggregate");
  await page.goto("/agent");
  await page.getByRole("link", { name: "Skills" }).click();
  await page.getByRole("button", { name: /使用 临租订单分析/ }).click();
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByRole("region", { name: "受治理聚合结果" })).toBeVisible();
  await expect(page.getByText(/2026 年 6 月\s+临租订单数为/)).toBeVisible();
  await expect(page.getByText("11")).toBeVisible();
  await expect(page.getByText("完整执行")).toBeVisible();
  await expect(page.getByText(/组织归属质量：100%/)).toBeVisible();
  await expect(page.getByText("Executing governed aggregate")).toHaveCount(0);
  if (process.env.CAPTURE_DEMO === "1") {
    await page.screenshot({ path: demoAsset("workbench-structured-answer.png") });
  }
  await page.reload();
  await expect(page.getByRole("region", { name: "受治理聚合结果" })).toBeVisible();
  await expect(page.getByText("Executing governed aggregate")).toHaveCount(0);
});

test("Management report renders governed comparisons and recovers after refresh", async ({ page }) => {
  await mockPiWorkbench(page, "comparison");
  await page.goto("/agent");
  await page.getByRole("link", { name: "Skills" }).click();
  await page.getByRole("button", { name: /使用 车辆经营分析报告/ }).click();
  await page.getByRole("button", { name: "发送问题" }).click();

  await expect(page.getByRole("heading", { name: "2026 年 6 月临租订单经营分析报告", exact: true })).toBeVisible();
  const reportHeading = await page.getByRole("heading", { name: "2026 年 6 月临租订单经营分析报告", exact: true }).boundingBox();
  const evidenceSummary = await page.getByText("数据依据", { exact: true }).boundingBox();
  expect(reportHeading?.y).toBeLessThan(evidenceSummary?.y ?? 0);
  await expect(page.getByRole("region", { name: "受治理比较结果" }).first()).not.toBeVisible();
  await page.getByText("数据依据", { exact: true }).click();
  await expect(page.getByRole("region", { name: "受治理比较结果" })).toHaveCount(2);
  await expect(page.getByRole("region", { name: "受治理比较结果" }).first()).toBeVisible();
  await expect(page.getByText("+3", { exact: true })).toBeVisible();
  await expect(page.getByText("+37.5%", { exact: true })).toBeVisible();
  await expect(page.getByText("供应商: 演示供应商 A")).toBeVisible();
  await expect(page.getByText("同一正式指标 · 同一登录 Principal 范围 · 同一筛选条件 · ClickHouse 全量聚合")).toHaveCount(2);
  await expect(page.getByText("Analyze governed comparisons")).toHaveCount(0);
  await expect(page.getByText(/organizationIds|organization_key|org-[0-9]/i)).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "执行摘要" })).toBeVisible();
  await page.getByText("数据依据", { exact: true }).click();
  await expect(page.getByRole("region", { name: "受治理比较结果" })).toHaveCount(2);
  await expect(page.getByRole("region", { name: "受治理比较结果" }).first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});

test("Ontology semantic layer is a real workspace view", async ({ page }) => {
  await mockPiWorkbench(page);
  await page.goto("/agent/ontology");
  await expect(page.getByRole("heading", { name: "Ontology 语义层", level: 1 })).toBeVisible();
  await expect(page.getByText("2").first()).toBeVisible();
  await expect(page.getByText("临租订单数")).toBeVisible();
  await expect(page.getByText("vehicle.count.short_rental_order")).toBeVisible();
  await expect(page.getByText("secret_table")).toHaveCount(0);
  if (process.env.CAPTURE_DEMO === "1") {
    await page.screenshot({ path: demoAsset("ontology-workspace.png") });
  }
});

test("OntoFleet first screen remains usable on mobile", async ({ page }) => {
  await mockPiWorkbench(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/agent");
  await expect(page.getByRole("button", { name: "打开导航" })).toBeVisible();
  await expect(page.getByLabel("直接描述问题")).toBeVisible();
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.getByRole("button", { name: "新建分析" })).toBeVisible();
  const rail = await page.locator(".agent-rail").boundingBox();
  expect(rail?.width).toBeGreaterThanOrEqual(270);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});

test("Sidebar keeps new conversations, history, and signed-in identity usable", async ({ page }) => {
  await mockPiWorkbench(page);
  await page.setViewportSize({ width: 1200, height: 720 });
  await page.goto("/agent");

  await expect(page.getByText("浏览器测试用户")).toBeVisible();
  await expect(page.getByText("browser@example.test")).toBeVisible();
  await expect(page.getByRole("button", { name: "搜索会话或 Skill" })).toBeVisible();
  await expect(page.locator(".brand-mark, .product-mark")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建分析" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.getByRole("button", { name: "新建分析" }).locator("svg")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "新建分析" })).toHaveCSS("font-size", "12px");
  await expect(page.getByRole("link", { name: "Skills" })).toHaveCSS("font-size", "12px");
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Skills" })).toBeVisible();
  await expect(page.getByRole("link", { name: "已归档会话" })).toBeVisible();
  await expect(page.getByText("数据库", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新建分析" }).click();
  await expect(page).toHaveURL(`/agent/${threadId}`);
  await expect(page.locator(".conversation-panel").getByRole("link", { name: /新对话/ })).toBeVisible();

  const recent = await page.locator(".conversation-panel").boundingBox();
  const account = await page.locator(".workspace-account").boundingBox();
  expect(recent?.height).toBeGreaterThanOrEqual(120);
  expect((account?.y ?? 1000) + (account?.height ?? 1000)).toBeLessThanOrEqual(720);
  await expect(page.locator(".project-list-label")).toHaveText("项目");
});

test("Sidebar width is draggable, keyboard accessible, and remembered", async ({ page }) => {
  await mockPiWorkbench(page);
  await page.setViewportSize({ width: 1200, height: 720 });
  await page.goto("/agent");
  const rail = page.locator(".agent-rail");
  const resizer = page.getByRole("separator", { name: "调整侧栏宽度" });
  const initial = await rail.boundingBox();
  expect(initial?.width).toBeGreaterThanOrEqual(295);

  const handle = await resizer.boundingBox();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 180);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 96, handle!.y + 180, { steps: 6 });
  await page.mouse.up();
  const dragged = await rail.boundingBox();
  expect(dragged?.width).toBeGreaterThan((initial?.width ?? 0) + 80);
  expect(dragged?.width).toBeLessThanOrEqual(480);

  await resizer.focus();
  await page.keyboard.press("ArrowLeft");
  const keyboardAdjusted = await rail.boundingBox();
  expect(keyboardAdjusted?.width).toBeLessThan(dragged?.width ?? 0);
  await page.reload();
  const restored = await page.locator(".agent-rail").boundingBox();
  expect(restored?.width).toBe(keyboardAdjusted?.width);
});

test("Threads can be archived, restored, and permanently deleted", async ({ page }) => {
  await mockPiWorkbench(page);
  await page.goto("/agent");
  await page.getByRole("button", { name: "新建分析" }).click();
  const conversation = page.locator(".conversation-item").filter({ hasText: "新对话" });
  await expect(conversation).toBeVisible();

  await conversation.hover();
  await expect(conversation.getByRole("button", { name: "归档会话 新对话" })).toBeVisible();
  await conversation.getByLabel("更多会话操作 新对话").click({ force: true });
  await page.getByRole("button", { name: "固定会话" }).click();
  await expect(conversation.locator(".conversation-title svg")).toHaveCount(1);

  await conversation.getByLabel("更多会话操作 新对话").click({ force: true });
  await page.getByRole("button", { name: "重命名" }).click();
  await page.getByRole("textbox", { name: "重命名会话 新对话" }).fill("六月经营分析");
  await page.getByRole("button", { name: "保存名称" }).click();
  await expect(page.getByRole("link", { name: /六月经营分析/ })).toBeVisible();
  await expect(page.locator(".thread-project").filter({ hasText: "经营分析报告" })).toBeVisible();
  await page.getByRole("button", { name: "搜索会话或 Skill" }).click();
  await page.getByPlaceholder("搜索会话或 Skill").fill("不存在的资源");
  await expect(page.getByText("没有匹配结果")).toBeVisible();
  await page.getByPlaceholder("搜索会话或 Skill").fill("六月");
  await expect(page.locator(".rail-search-results").getByRole("link", { name: /六月经营分析/ })).toBeVisible();
  await page.getByPlaceholder("搜索会话或 Skill").fill("");

  const renamed = page.locator(".conversation-item").filter({ hasText: "六月经营分析" });
  await renamed.hover();
  await renamed.getByRole("button", { name: "归档会话 六月经营分析" }).click();
  await expect(page.getByRole("button", { name: "撤销" })).toBeVisible();
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByRole("link", { name: /六月经营分析/ })).toBeVisible();

  const restored = page.locator(".conversation-item").filter({ hasText: "六月经营分析" });
  await restored.hover();
  await restored.getByRole("button", { name: "归档会话 六月经营分析" }).click();
  await page.getByRole("link", { name: "已归档会话" }).click();
  await expect(page).toHaveURL("/agent/archived");
  const archived = page.locator(".archived-thread-list .conversation-item").filter({ hasText: "六月经营分析" });
  await expect(archived).toBeVisible();
  await archived.hover();
  await archived.getByRole("button", { name: "恢复会话 六月经营分析" }).click();
  await page.goto("/agent");
  await expect(page.getByRole("link", { name: /六月经营分析/ })).toBeVisible();

  await page.getByLabel("更多会话操作 六月经营分析").click({ force: true });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "永久删除" }).click();
  await expect(page.locator(".conversation-panel").getByText("暂无会话")).toBeVisible();
});

test("Projects can be created, renamed, assigned, deleted, and recovered from local persistence", async ({ page }) => {
  await mockPiWorkbench(page);
  await page.goto("/agent");
  await page.getByRole("button", { name: "新建分析" }).click();

  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("textbox", { name: "项目名称" }).fill("月度运营");
  await page.getByRole("button", { name: "创建项目" }).click();
  let project = page.locator(".thread-project-shell").filter({ has: page.locator(".thread-project > summary > span").filter({ hasText: /^月度运营$/ }) });
  await expect(project).toBeVisible();

  const conversation = page.locator(".conversation-item").filter({ hasText: "新对话" });
  await conversation.getByLabel("更多会话操作 新对话").click({ force: true });
  await conversation.getByLabel("项目").selectOption({ label: "月度运营" });
  project = page.locator(".thread-project-shell").filter({ has: page.locator(".thread-project > summary > span").filter({ hasText: /^月度运营$/ }) });
  await expect(project.getByRole("link", { name: /新对话/ })).toBeVisible();

  await project.hover();
  await project.getByLabel("管理项目 月度运营").click();
  await project.getByRole("button", { name: "重命名" }).click();
  await page.getByRole("textbox", { name: "重命名项目 月度运营" }).fill("重点经营");
  await page.getByRole("button", { name: "保存项目名称" }).click();
  project = page.locator(".thread-project-shell").filter({ has: page.locator(".thread-project > summary > span").filter({ hasText: /^重点经营$/ }) });
  await expect(project).toBeVisible();

  await project.hover();
  await project.getByLabel("管理项目 重点经营").click();
  page.once("dialog", (dialog) => dialog.accept());
  await project.getByRole("button", { name: "删除项目" }).click();
  await expect(page.getByText("重点经营", { exact: true })).toHaveCount(0);
  await expect(page.locator(".thread-project-shell").filter({ hasText: "未分类" }).getByRole("link", { name: /新对话/ })).toBeVisible();

  await page.reload();
  await expect(page.getByText("重点经营", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /新对话/ })).toBeVisible();
});

test("Database sources and account stay fixed while the conversation list scrolls", async ({ page }) => {
  await mockPiWorkbench(page);
  await page.setViewportSize({ width: 1200, height: 520 });
  await page.goto("/agent");

  const scroller = page.locator(".conversation-list-scroll");
  const database = page.locator(".database-section");
  const conversations = page.locator(".conversation-panel");
  const account = page.locator(".workspace-account");
  const beforeDatabase = await database.boundingBox();
  const beforeConversations = await conversations.boundingBox();
  const beforeAccount = await account.boundingBox();
  await expect(scroller).toHaveCSS("overflow-y", "auto");

  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const afterDatabase = await database.boundingBox();
  const afterConversations = await conversations.boundingBox();
  const afterAccount = await account.boundingBox();
  expect(afterDatabase?.y).toBe(beforeDatabase?.y);
  expect(afterConversations?.y).toBe(beforeConversations?.y);
  expect(afterAccount?.y).toBe(beforeAccount?.y);
  expect((afterAccount?.y ?? 1000) + (afterAccount?.height ?? 1000)).toBeLessThanOrEqual(520);
});
