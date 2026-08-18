import { readFile } from "node:fs/promises";
import path from "node:path";

export type OntologyKind = "metric" | "entity" | "event" | "field" | "relation" | "time";

export interface CapabilityGap {
  code: string;
  description: string;
}

export interface OntologyDimension {
  fieldId: string;
  label: string;
  entityTypeId?: string;
  allowedOperations: string[];
}

export interface OntologyTimeSemantics {
  businessTimeFieldId?: string;
  businessTimeRole?: string;
  eventTimeFieldId?: string;
  eventTimeRole?: string;
  timezone?: string;
  allowedWindow?: string;
}

export interface OntologyItem {
  id: string;
  kind: OntologyKind;
  label: string;
  description: string;
  status: string;
  aliases?: string[];
  executable?: boolean;
  aggregation?: string;
  unit?: string;
  grain?: string;
  valueType?: string;
  businessRole?: string;
  allowedOperations?: string[];
  dimensions?: OntologyDimension[];
  identityFieldIds?: string[];
  timeSemantics?: OntologyTimeSemantics;
  capabilityGaps?: CapabilityGap[];
  sourceSemanticId?: string;
  targetSemanticId?: string;
  relationType?: string;
  direction?: string;
  usedByMetricIds?: string[];
  usedByEventIds?: string[];
}

export interface OntologyCounts {
  entities: number;
  events: number;
  fields: number;
  metrics: number;
  relations: number;
  timeSemantics: number;
}

export interface OntologyView {
  schemaVersion: "pi-ontology-view.v1";
  workspaceId: string;
  resourceVersion: string;
  counts: OntologyCounts;
  items: OntologyItem[];
  total: number;
}

type SemanticIndex = {
  workspaceId?: unknown;
  resourceVersion?: unknown;
  entityTypes?: unknown;
  eventTypes?: unknown;
  metricDefinitions?: unknown;
  relationTypes?: unknown;
  timeSemantics?: unknown;
};

type MetricRegistry = { metrics?: unknown };

type FieldAccumulator = {
  id: string;
  label: string;
  valueTypes: Set<string>;
  roles: Set<string>;
  operations: Set<string>;
  metricIds: Set<string>;
  status: string;
};

export class OntologyCatalog {
  private constructor(
    readonly workspaceId: string,
    readonly resourceVersion: string,
    readonly counts: OntologyCounts,
    private readonly items: OntologyItem[],
  ) {}

  static async load(file: string): Promise<OntologyCatalog> {
    const raw = await readFile(file, "utf8");
    const registryFile = path.join(path.dirname(file), "source-registry", "metric-definitions-v3.json");
    let metricRegistry: unknown;
    try {
      metricRegistry = JSON.parse(await readFile(registryFile, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return OntologyCatalog.from(JSON.parse(raw) as unknown, metricRegistry);
  }

  static empty(): OntologyCatalog {
    return new OntologyCatalog("unavailable", "unavailable", {
      entities: 0,
      events: 0,
      fields: 0,
      metrics: 0,
      relations: 0,
      timeSemantics: 0,
    }, []);
  }

  static from(value: unknown, metricRegistryValue?: unknown): OntologyCatalog {
    if (!isRecord(value)) throw new Error("Semantic Index must be a JSON object");
    const index = value as SemanticIndex;
    const entities = records(index.entityTypes);
    const events = records(index.eventTypes);
    const metrics = records(index.metricDefinitions);
    const relations = records(index.relationTypes);
    const times = records(index.timeSemantics);
    const policies = metricPolicies(metricRegistryValue);
    const entityLabels = new Map(
      entities.flatMap((entity) => {
        const id = stringValue(entity.entityTypeId);
        return id ? [[id, localizedName(entity.name) || id] as const] : [];
      }),
    );
    const timeLabels = new Map(
      times.flatMap((time) => {
        const id = stringValue(time.timeRoleId);
        return id ? [[id, stringValue(time.role) || id] as const] : [];
      }),
    );
    const items = [
      ...metrics.map((metric) => metricItem(metric, policies.get(stringValue(metric.metricId)), entityLabels)),
      ...entities.map(entityItem),
      ...events.map(eventItem),
      ...fieldItems(entities, metrics, entityLabels, timeLabels),
      ...relations.map((relation) => relationItem(relation, entityLabels)),
      ...times.map(timeItem),
    ].filter((item): item is OntologyItem => item !== undefined);
    const fields = items.filter((item) => item.kind === "field").length;
    return new OntologyCatalog(
      stringValue(index.workspaceId) || "unknown",
      stringValue(index.resourceVersion) || "unknown",
      {
        entities: entities.length,
        events: events.length,
        fields,
        metrics: metrics.length,
        relations: relations.length,
        timeSemantics: times.length,
      },
      items,
    );
  }

  view(query = "", kind?: OntologyKind, limit = 200): OntologyView {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const filtered = this.items.filter((item) => {
      if (kind && item.kind !== kind) return false;
      if (!needle) return true;
      return ontologySearchText(item).toLocaleLowerCase("zh-CN").includes(needle);
    });
    return {
      schemaVersion: "pi-ontology-view.v1",
      workspaceId: this.workspaceId,
      resourceVersion: this.resourceVersion,
      counts: this.counts,
      items: filtered.slice(0, Math.max(1, Math.min(limit, 200))),
      total: filtered.length,
    };
  }

  search(query: string, kinds: OntologyKind[] = [], limit = 8): OntologyItem[] {
    const allowed = kinds.length ? new Set(kinds) : undefined;
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return this.items
      .filter((item) => {
        if (allowed && !allowed.has(item.kind)) return false;
        if (!needle) return true;
        return ontologySearchText(item).toLocaleLowerCase("zh-CN").includes(needle);
      })
      .slice(0, Math.max(1, Math.min(limit, 20)));
  }

  describe(id: string): OntologyItem | undefined {
    return this.items.find((item) => item.id === id);
  }
}

function metricItem(
  value: Record<string, unknown>,
  policy: Record<string, unknown> | undefined,
  entityLabels: ReadonlyMap<string, string>,
): OntologyItem | undefined {
  const id = stringValue(value.metricId);
  if (!id) return undefined;
  const executable = value.executable === true;
  const aggregation = stringValue(value.aggregator) || stringValue(policy?.aggregation);
  const status = stringValue(value.publicationStatus) || stringValue(value.approvalStatus) || "unknown";
  const reasons = listValue(value.statusReasons);
  const aliases = records(value.aliases).map((alias) => stringValue(alias.text)).filter(Boolean);
  const dimensions = records(value.dimensions).flatMap((dimension) => {
    const fieldId = stringValue(dimension.fieldId);
    if (!fieldId) return [];
    const entityTypeId = stringValue(dimension.entityTypeId);
    return [{
      fieldId,
      label: entityLabels.get(entityTypeId) || stringValue(dimension.dimensionId) || fieldLabel(fieldId),
      ...(entityTypeId ? { entityTypeId } : {}),
      allowedOperations: dimensionOperations(fieldId),
    } satisfies OntologyDimension];
  });
  const identityFieldIds = records(value.fieldMappings)
    .filter((mapping) => mapping.role === "identity_key")
    .map((mapping) => stringValue(mapping.logicalFieldId))
    .filter(Boolean);
  const time = isRecord(value.timeSemantics) ? value.timeSemantics : {};
  const timeSemantics = compactTimeSemantics(time);
  const gaps = capabilityGaps(value.capabilityGaps);
  if (dimensions.some((dimension) => dimension.fieldId === "vehicle.dimension.organization")) {
    gaps.push({
      code: "organization_scope_server_only",
      description: "组织范围仅由服务端 Principal 注入，不允许模型或浏览器筛选或分组。",
    });
  }
  if (dimensions.some((dimension) => new Set(["vehicle.dimension.vehicle", "vehicle.dimension.employee"]).has(dimension.fieldId))) {
    gaps.push({
      code: "high_cardinality_grouping_limited",
      description: "车辆和员工高基数分组尚无已发布的结果上限与脱敏策略，当前不可执行分组。",
    });
  }
  const grainValue = isRecord(value.grain)
    ? stringValue(value.grain.description) || stringValue(value.grain.entityTypeId)
    : stringValue(value.grain) || stringValue(policy?.grain);
  const unit = stringValue(policy?.unit) || (aggregation === "count_distinct" ? "count" : "");
  return {
    id,
    kind: "metric",
    label: stringValue(value.canonicalNameZh) || stringValue(policy?.displayName) || id,
    description: reasons.join("；") || (aggregation ? `聚合口径：${aggregation}` : "正式指标定义"),
    status,
    executable,
    ...(aliases.length ? { aliases } : {}),
    ...(aggregation ? { aggregation } : {}),
    ...(unit ? { unit } : {}),
    ...(grainValue ? { grain: grainValue } : {}),
    allowedOperations: executable ? ["describe", "aggregate"] : ["describe"],
    ...(dimensions.length ? { dimensions } : {}),
    ...(identityFieldIds.length ? { identityFieldIds } : {}),
    ...(Object.keys(timeSemantics).length ? { timeSemantics } : {}),
    ...(gaps.length ? { capabilityGaps: uniqueGaps(gaps) } : {}),
  };
}

function entityItem(value: Record<string, unknown>): OntologyItem | undefined {
  const id = stringValue(value.entityTypeId);
  if (!id) return undefined;
  return {
    id,
    kind: "entity",
    label: localizedName(value.name) || id,
    description: listValue(value.stereotypes).join(" · ") || "业务实体",
    status: stringValue(value.approvalStatus) || "unknown",
    allowedOperations: ["describe"],
  };
}

function eventItem(value: Record<string, unknown>): OntologyItem | undefined {
  const id = stringValue(value.eventSetId);
  if (!id) return undefined;
  return {
    id,
    kind: "event",
    label: localizedName(value.name) || id,
    description: stringValue(value.grain) || "业务事件",
    status: stringValue(value.publicationStatus) || stringValue(value.approvalStatus) || "unknown",
    ...(stringValue(value.grain) ? { grain: stringValue(value.grain) } : {}),
    allowedOperations: ["describe"],
    usedByEventIds: [id],
  };
}

function fieldItems(
  entities: Array<Record<string, unknown>>,
  metrics: Array<Record<string, unknown>>,
  entityLabels: ReadonlyMap<string, string>,
  timeLabels: ReadonlyMap<string, string>,
): OntologyItem[] {
  const fields = new Map<string, FieldAccumulator>();
  const ensure = (id: string, label: string, status = "published") => {
    const existing = fields.get(id);
    if (existing) {
      if (existing.label === fieldLabel(id) && label !== existing.label) existing.label = label;
      return existing;
    }
    const created: FieldAccumulator = {
      id,
      label,
      valueTypes: new Set(),
      roles: new Set(),
      operations: new Set(["describe"]),
      metricIds: new Set(),
      status,
    };
    fields.set(id, created);
    return created;
  };

  for (const entity of entities) {
    const entityId = stringValue(entity.entityTypeId);
    const entityLabel = entityLabels.get(entityId) || entityId;
    for (const field of records(entity.fields)) {
      const id = stringValue(field.fieldId);
      if (!id) continue;
      const item = ensure(id, `${entityLabel} · ${fieldLabel(id)}`, stringValue(entity.approvalStatus) || "unknown");
      item.roles.add("entity_attribute");
      const valueType = semanticValueType(field.valueType);
      if (valueType) item.valueTypes.add(valueType);
    }
  }

  for (const metric of metrics) {
    const metricId = stringValue(metric.metricId);
    const status = stringValue(metric.publicationStatus) || stringValue(metric.approvalStatus) || "unknown";
    const dimensionLabels = new Map(
      records(metric.dimensions).flatMap((dimension) => {
        const fieldId = stringValue(dimension.fieldId);
        if (!fieldId) return [];
        const entityId = stringValue(dimension.entityTypeId);
        return [[fieldId, entityLabels.get(entityId) || stringValue(dimension.dimensionId) || fieldLabel(fieldId)] as const];
      }),
    );
    for (const mapping of records(metric.fieldMappings)) {
      const id = stringValue(mapping.logicalFieldId);
      if (!id || timeLabels.has(id)) continue;
      const role = stringValue(mapping.role) || "semantic_field";
      const item = ensure(id, dimensionLabels.get(id) || timeLabels.get(id) || fieldLabel(id), status);
      item.roles.add(role);
      if (metricId) item.metricIds.add(metricId);
      for (const operation of fieldOperations(id, role)) item.operations.add(operation);
      const valueType = semanticValueType(mapping.sourceType);
      if (valueType) item.valueTypes.add(valueType);
    }
  }

  return [...fields.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((field) => ({
      id: field.id,
      kind: "field" as const,
      label: field.label,
      description: `业务字段；角色：${[...field.roles].sort().join("、")}`,
      status: field.status,
      ...(field.valueTypes.size ? { valueType: [...field.valueTypes].sort().join("|") } : {}),
      businessRole: [...field.roles].sort().join(","),
      allowedOperations: [...field.operations].sort(),
      ...(field.metricIds.size ? { usedByMetricIds: [...field.metricIds].sort() } : {}),
    }));
}

function relationItem(
  value: Record<string, unknown>,
  entityLabels: ReadonlyMap<string, string>,
): OntologyItem | undefined {
  const id = stringValue(value.relationId);
  if (!id) return undefined;
  const sourceSemanticId = stringValue(value.sourceEntityTypeId);
  const targetSemanticId = stringValue(value.targetEntityTypeId);
  const relationType = stringValue(value.relationType) || "related_to";
  const sourceLabel = entityLabels.get(sourceSemanticId) || sourceSemanticId || "来源语义项";
  const targetLabel = entityLabels.get(targetSemanticId) || targetSemanticId || "目标语义项";
  const schemaOnly = stringValue(value.physicalizationMode) === "schema_only";
  return {
    id,
    kind: "relation",
    label: `${sourceLabel} ${relationType} ${targetLabel}`,
    description: `${sourceSemanticId} 到 ${targetSemanticId} 的正式语义关系。`,
    status: stringValue(value.approvalStatus) || "unknown",
    ...(sourceSemanticId ? { sourceSemanticId } : {}),
    ...(targetSemanticId ? { targetSemanticId } : {}),
    relationType,
    ...(stringValue(value.direction) ? { direction: stringValue(value.direction) } : {}),
    allowedOperations: schemaOnly ? ["describe"] : ["describe", "traverse"],
    ...(schemaOnly ? { capabilityGaps: [{
      code: "relation_schema_only",
      description: "该关系当前仅用于语义拓扑说明，没有已发布的数据遍历执行器。",
    }] } : {}),
  };
}

function timeItem(value: Record<string, unknown>): OntologyItem | undefined {
  const id = stringValue(value.timeRoleId);
  if (!id) return undefined;
  const usedByEventIds = records(value.mappings)
    .map((mapping) => stringValue(mapping.eventSetId))
    .filter(Boolean);
  return {
    id,
    kind: "time",
    label: stringValue(value.role) || id,
    description: stringValue(value.description) || "业务时间语义",
    status: stringValue(value.availability) || "unknown",
    businessRole: stringValue(value.role) || "business_time",
    valueType: "business_time",
    allowedOperations: ["describe", "time_filter"],
    ...(usedByEventIds.length ? { usedByEventIds: [...new Set(usedByEventIds)].sort() } : {}),
  };
}

function metricPolicies(value: unknown): Map<string, Record<string, unknown>> {
  if (!isRecord(value)) return new Map();
  const registry = value as MetricRegistry;
  return new Map(records(registry.metrics).flatMap((metric) => {
    const id = stringValue(metric.metricId);
    return id ? [[id, metric] as const] : [];
  }));
}

function compactTimeSemantics(value: Record<string, unknown>): OntologyTimeSemantics {
  const result: OntologyTimeSemantics = {};
  for (const [source, target] of [
    ["businessTimeFieldId", "businessTimeFieldId"],
    ["businessTimeRole", "businessTimeRole"],
    ["eventTimeFieldId", "eventTimeFieldId"],
    ["eventTimeRole", "eventTimeRole"],
    ["timezone", "timezone"],
    ["allowedWindow", "allowedWindow"],
  ] as const) {
    const item = stringValue(value[source]);
    if (item && item !== "not_applicable") result[target] = item;
  }
  return result;
}

function dimensionOperations(fieldId: string): string[] {
  if (fieldId === "vehicle.dimension.organization") return ["server_scope"];
  if (new Set(["vehicle.dimension.vehicle", "vehicle.dimension.employee"]).has(fieldId)) return ["filter"];
  return ["filter", "group_by"];
}

function fieldOperations(fieldId: string, role: string): string[] {
  if (role === "organization_key" || fieldId === "vehicle.dimension.organization") return ["server_scope"];
  if (role === "business_time") return ["time_filter"];
  if (role === "identity_key") return ["count_distinct"];
  if (role === "dimension") return dimensionOperations(fieldId);
  return [];
}

function semanticValueType(value: unknown): string {
  const source = stringValue(value).toLowerCase();
  if (!source) return "";
  if (source.includes("datetime") || source.includes("date")) return "datetime";
  if (source.includes("decimal") || source.includes("float") || source.includes("int")) return "number";
  if (source.includes("bool")) return "boolean";
  if (source.includes("string")) return "string";
  return "unknown";
}

function capabilityGaps(value: unknown): CapabilityGap[] {
  return records(value).flatMap((gap) => {
    const code = stringValue(gap.code);
    const description = stringValue(gap.description);
    return code && description ? [{ code, description }] : [];
  });
}

function uniqueGaps(value: CapabilityGap[]): CapabilityGap[] {
  return [...new Map(value.map((gap) => [`${gap.code}\u0000${gap.description}`, gap])).values()];
}

function ontologySearchText(item: OntologyItem): string {
  return [
    item.id,
    item.label,
    item.description,
    ...(item.aliases ?? []),
    item.sourceSemanticId ?? "",
    item.targetSemanticId ?? "",
    item.relationType ?? "",
    ...(item.dimensions ?? []).flatMap((dimension) => [dimension.fieldId, dimension.label]),
  ].join(" ");
}

function fieldLabel(id: string): string {
  const tail = id.split(".").at(-1) || id;
  const known: Record<string, string> = {
    business_month: "业务月份",
    calendar_month: "日历月份",
    employee: "员工",
    order_id: "订单标识",
    organization: "组织范围",
    record_id: "记录标识",
    supplier: "供应商",
    vehicle: "车辆（车牌）",
  };
  return known[tail] || tail.replaceAll("_", " ");
}

function localizedName(value: unknown): string {
  if (!isRecord(value)) return stringValue(value);
  return stringValue(value.zhCn) || stringValue(value.enUs);
}

function listValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(stringValue).filter(Boolean);
  const text = stringValue(value);
  return text ? text.split(/\s+/).filter(Boolean) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
