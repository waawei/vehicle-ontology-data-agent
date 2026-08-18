export type PiRuntimeConfig = {
  runtime: string;
  provider: string;
  modelId: string;
  modelName: string;
  thinkingLevel: string;
  reasoningEnabled: boolean;
  keyConfigured: boolean;
  persistence: string;
};

export type PiThreadEvent = {
  sequence?: number;
  type: string;
  at?: string;
  runId?: string;
  toolName?: string;
  skillId?: string;
  label?: string;
  status?: string;
};

export type PiSkill = {
  id: string;
  label: string;
  summary: string;
  status: "available" | "limited";
  prompt: string;
  toolNames: string[];
};

export type PiDataSource = {
  id: string;
  label: string;
  description: string;
  kind: "semantic" | "database";
  status: "online" | "offline" | "unknown";
  readOnly: boolean;
  href: string;
};

export type PiWorkspace = {
  schemaVersion: "pi-workspace.v1";
  skills: PiSkill[];
  dataSources: PiDataSource[];
  ontology: {
    workspaceId: string;
    resourceVersion: string;
    counts: { entities: number; events: number; fields: number; metrics: number; relations: number; timeSemantics: number };
  };
  routing: { mode: "automatic"; fallback: string; modelId: string; thinkingLevel: string };
};

export type PiOntologyKind = "metric" | "entity" | "event" | "field" | "relation" | "time";

export type PiOntologyItem = {
  id: string;
  kind: PiOntologyKind;
  label: string;
  description: string;
  status: string;
  executable?: boolean;
  aggregation?: string;
  unit?: string;
  grain?: string;
  valueType?: string;
  businessRole?: string;
  allowedOperations?: string[];
  dimensions?: Array<{ fieldId: string; label: string; entityTypeId?: string; allowedOperations: string[] }>;
  identityFieldIds?: string[];
  timeSemantics?: Record<string, string>;
  capabilityGaps?: Array<{ code: string; description: string }>;
  sourceSemanticId?: string;
  targetSemanticId?: string;
  relationType?: string;
  direction?: string;
};

export type PiVehicleAggregateObservation = {
  metricId: string;
  label: string;
  value: number | string | null;
  unit: string;
  time: { kind: "business_month"; value: string };
  groups: Array<{ keys: Record<string, string | number | null>; value: number | string }>;
  completeness: "complete" | "partial";
  dataQuality: {
    organizationAttribution: {
      status: "not_measured" | "measured";
      coverage: number | null;
      numerator: number | null;
      denominator: number | null;
      basis: "metric_identity";
      timeRange: { kind: "business_month"; start: string; end: string } | null;
      topologyVersion: string | null;
    };
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
};

export type PiVehiclePeriodChange = {
  absoluteChange: number | string;
  percentChange: number | null;
  direction: "increase" | "decrease" | "unchanged";
  status: "computed" | "baseline_zero";
};

export type PiVehicleCompareObservation = {
  metricId: string;
  label: string;
  unit: string;
  current: PiVehicleAggregateObservation;
  baseline: PiVehicleAggregateObservation;
  change: PiVehiclePeriodChange | null;
  groups: Array<{
    keys: Record<string, string | number | null>;
    currentValue: number | string;
    baselineValue: number | string;
    change: PiVehiclePeriodChange;
  }>;
  completeness: "complete" | "partial";
  provenance: {
    calculation: "period_over_period";
    comparisonBasis: "same_metric_same_principal_scope_same_filters";
    groupResultLimit: number | null;
    groupResultTruncated: boolean;
  };
};

export type PiOntologyView = {
  schemaVersion: "pi-ontology-view.v1";
  workspaceId: string;
  resourceVersion: string;
  counts: PiWorkspace["ontology"]["counts"];
  items: PiOntologyItem[];
  total: number;
};

export type PiThread = {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "running" | "failed";
  archivedAt?: string;
  activeRunId?: string;
  lastError?: string;
  messages: unknown[];
  events: PiThreadEvent[];
  messageCount?: number;
  eventCount?: number;
  pinnedAt?: string;
};

export type PiPromptResult = {
  threadId: string;
  runId: string;
  status: string;
  answer: string;
  events: PiThreadEvent[];
};

type ErrorBody = { error?: { code?: string; message?: string }; code?: string; message?: string };

export class PiAgentApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(statusValue: number, codeValue: string, message: string) {
    super(message);
    this.status = statusValue;
    this.code = codeValue;
  }
}

function csrfToken(): string {
  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("r6_csrf="));
  return cookie ? decodeURIComponent(cookie.slice("r6_csrf=".length)) : "";
}

async function request<T>(path: string, init: Parameters<typeof fetch>[1] = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Pi-Agent-Client", "workbench");
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.method && init.method !== "GET") headers.set("X-CSRF-Token", csrfToken());

  let response: Response;
  try {
    response = await fetch(`/pi-agent${path}`, { ...init, headers, credentials: "include" });
  } catch {
    throw new PiAgentApiError(0, "PI_AGENT_UNAVAILABLE", "Pi Agent 服务暂时不可用。");
  }
  const body = await response.json().catch(() => undefined) as unknown;
  if (response.status === 401) window.dispatchEvent(new Event("workbench:auth-expired"));
  if (!response.ok) {
    const errorBody = (body && typeof body === "object" ? body : {}) as ErrorBody;
    const detail = errorBody.error ?? errorBody;
    throw new PiAgentApiError(
      response.status,
      detail.code ?? "PI_AGENT_REQUEST_FAILED",
      detail.message ?? "Pi Agent 请求未完成。",
    );
  }
  return body as T;
}

export function getPiRuntimeConfig() {
  return request<PiRuntimeConfig>("/config");
}

export function getPiWorkspace() {
  return request<PiWorkspace>("/workspace");
}

export function getPiOntology(query = "", kind?: PiOntologyKind) {
  const params = new URLSearchParams();
  if (query.trim()) params.set("query", query.trim());
  if (kind) params.set("kind", kind);
  const suffix = params.size ? `?${params}` : "";
  return request<PiOntologyView>(`/ontology${suffix}`);
}

export function listPiThreads(state: "active" | "archived" = "active") {
  return request<PiThread[]>(`/threads?state=${state}`);
}

export function createPiThread(title?: string) {
  return request<PiThread>("/threads", {
    method: "POST",
    body: JSON.stringify(title ? { title } : {}),
  });
}

export function getPiThread(threadId: string) {
  return request<PiThread>(`/threads/${encodeURIComponent(threadId)}`);
}

export function setPiThreadArchived(threadId: string, archived: boolean) {
  return updatePiThread(threadId, { archived });
}

export function setPiThreadPinned(threadId: string, pinned: boolean) {
  return updatePiThread(threadId, { pinned });
}

export function renamePiThread(threadId: string, title: string) {
  return updatePiThread(threadId, { title });
}

function updatePiThread(threadId: string, update: { archived: boolean } | { pinned: boolean } | { title: string }) {
  return request<PiThread>(`/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    body: JSON.stringify(update),
  });
}

export function deletePiThread(threadId: string) {
  return request<void>(`/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
}

export function sendPiMessage(threadId: string, content: string) {
  return request<PiPromptResult>(`/threads/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}
