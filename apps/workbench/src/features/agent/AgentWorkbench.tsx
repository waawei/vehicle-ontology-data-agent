import {
  Archive, ArchiveRestore, ArrowUp, ArrowUpRight, Boxes, CarFront, Check,
  ChevronDown, ChevronRight, CircleAlert, Database, Folder, GitCompareArrows, Layers3,
  LoaderCircle, Menu, MoreHorizontal, Network, PanelLeftClose, PanelLeftOpen, PanelRightOpen,
  PencilLine, Pin, PinOff, Plus, Search, ShieldCheck, Sparkles, SquarePen, SquareTerminal, Trash2, Wrench, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../../app/auth";
import { logout as logoutSession } from "../../api/auth";
import {
  PiAgentApiError, createPiThread, getPiOntology, getPiRuntimeConfig, getPiThread,
  deletePiThread, getPiWorkspace, listPiThreads, renamePiThread, sendPiMessage, setPiThreadArchived,
  setPiThreadPinned,
  type PiDataSource, type PiOntologyKind,
  type PiOntologyView, type PiRuntimeConfig, type PiSkill, type PiThread,
  type PiVehicleAggregateObservation, type PiVehicleCompareObservation, type PiVehiclePeriodChange,
  type PiThreadEvent, type PiWorkspace,
} from "../../api/piAgent";
import "./AgentWorkbench.css";

type DisplayMessage =
  | { role: "user" | "assistant"; text: string }
  | {
    role: "tool" | "toolResult";
    text: string;
    toolName?: string;
    observation?: PiVehicleAggregateObservation;
    comparison?: PiVehicleCompareObservation;
  };
type AgentView = "chat" | "skills" | "archived" | "workspace" | "ontology";
type ThreadGroup = { key: string; label: string; items: PiThread[] };
type ProjectRecord = { id: string; label: string; custom: boolean };
type ProjectState = { ownerId: string; projects: ProjectRecord[]; assignments: Record<string, string> };

const kindLabels: Record<PiOntologyKind, string> = {
  metric: "指标", entity: "实体", event: "事件", field: "字段", relation: "关系", time: "时间语义",
};
const skillIcons = [CarFront, Network, GitCompareArrows];
const DEFAULT_RAIL_WIDTH = 300;
const MIN_RAIL_WIDTH = 240;
const MAX_RAIL_WIDTH = 480;
const MIN_MAIN_WIDTH = 560;
const RAIL_WIDTH_STORAGE_KEY = "pi-agent.rail-width";
const PROJECTS_STORAGE_PREFIX = "pi-agent.projects.v1";
const EMPTY_PROMPTS = [
  "查询 2026 年 6 月临租订单数",
  "按供应商分组查询 2026 年 6 月长租车辆数",
  "生成 2026 年 6 月车辆经营分析报告",
];

function constrainRailWidth(value: number): number {
  const viewportLimit = typeof window === "undefined"
    ? MAX_RAIL_WIDTH
    : Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, window.innerWidth - MIN_MAIN_WIDTH));
  return Math.round(Math.min(viewportLimit, Math.max(MIN_RAIL_WIDTH, value)));
}

function initialRailWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY));
    const preferred = Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_RAIL_WIDTH;
    return Math.round(Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, preferred)));
  } catch {
    return DEFAULT_RAIL_WIDTH;
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const value = block as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n").trim();
}

function userVisibleAssistantText(content: unknown): string {
  return messageText(content)
    .replace(/<(thinking|analysis)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(thinking|analysis)\b[^>]*>[\s\S]*$/gi, "")
    .trim();
}

function isAggregateObservation(value: unknown): value is PiVehicleAggregateObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PiVehicleAggregateObservation>;
  return typeof candidate.metricId === "string"
    && typeof candidate.label === "string"
    && typeof candidate.unit === "string"
    && typeof candidate.time === "object"
    && candidate.time !== null
    && (candidate.time as { kind?: unknown }).kind === "business_month"
    && typeof (candidate.time as { value?: unknown }).value === "string"
    && Array.isArray(candidate.groups)
    && typeof candidate.dataQuality === "object"
    && candidate.dataQuality !== null
    && typeof candidate.dataQuality.organizationAttribution === "object"
    && candidate.dataQuality.organizationAttribution !== null
    && typeof candidate.provenance === "object"
    && candidate.provenance !== null;
}

function messageObservation(message: Record<string, unknown>): PiVehicleAggregateObservation | undefined {
  const details = message.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const observation = (details as { observation?: unknown }).observation;
  return isAggregateObservation(observation) ? observation : undefined;
}

function isPeriodChange(value: unknown): value is PiVehiclePeriodChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PiVehiclePeriodChange>;
  return isNumericScalar(candidate.absoluteChange)
    && (candidate.percentChange === null || (typeof candidate.percentChange === "number" && Number.isFinite(candidate.percentChange)))
    && (candidate.direction === "increase" || candidate.direction === "decrease" || candidate.direction === "unchanged")
    && (candidate.status === "computed" || candidate.status === "baseline_zero");
}

function isNumericScalar(value: unknown): value is number | string {
  return (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value));
}

function isComparisonGroup(value: unknown): value is PiVehicleCompareObservation["groups"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!candidate.keys || typeof candidate.keys !== "object" || Array.isArray(candidate.keys)) return false;
  const keys = candidate.keys as Record<string, unknown>;
  if ("vehicle.dimension.organization" in keys) return false;
  const validKeys = Object.entries(keys).every(([key, item]) => Boolean(key)
    && (item === null || typeof item === "string" || (typeof item === "number" && Number.isFinite(item))));
  return validKeys
    && isNumericScalar(candidate.currentValue)
    && isNumericScalar(candidate.baselineValue)
    && isPeriodChange(candidate.change);
}

function isCompareObservation(value: unknown): value is PiVehicleCompareObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PiVehicleCompareObservation>;
  return typeof candidate.metricId === "string"
    && typeof candidate.label === "string"
    && typeof candidate.unit === "string"
    && isAggregateObservation(candidate.current)
    && isAggregateObservation(candidate.baseline)
    && (candidate.change === null || isPeriodChange(candidate.change))
    && Array.isArray(candidate.groups)
    && candidate.groups.every(isComparisonGroup)
    && (candidate.completeness === "complete" || candidate.completeness === "partial")
    && typeof candidate.provenance === "object"
    && candidate.provenance !== null
    && candidate.provenance.calculation === "period_over_period"
    && candidate.provenance.comparisonBasis === "same_metric_same_principal_scope_same_filters"
    && typeof candidate.provenance.groupResultTruncated === "boolean"
    && (candidate.provenance.groupResultLimit === null
      || (Number.isInteger(candidate.provenance.groupResultLimit) && Number(candidate.provenance.groupResultLimit) > 0))
    && candidate.current.metricId === candidate.metricId
    && candidate.baseline.metricId === candidate.metricId
    && candidate.current.label === candidate.label
    && candidate.baseline.label === candidate.label
    && candidate.current.unit === candidate.unit
    && candidate.baseline.unit === candidate.unit;
}

function messageComparison(message: Record<string, unknown>): PiVehicleCompareObservation | undefined {
  const details = message.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const comparison = (details as { comparison?: unknown }).comparison;
  return isCompareObservation(comparison) ? comparison : undefined;
}

function displayMessages(thread: PiThread | null): DisplayMessage[] {
  if (!thread) return [];
  return thread.messages.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const message = value as { role?: unknown; content?: unknown; toolName?: unknown; details?: unknown };
    const role = message.role === "user" || message.role === "assistant"
      || message.role === "tool" || message.role === "toolResult" ? message.role : null;
    if (!role) return [];
    const text = role === "assistant"
      ? userVisibleAssistantText(message.content)
      : messageText(message.content);
    const observation = role === "toolResult" ? messageObservation(message) : undefined;
    const comparison = role === "toolResult" ? messageComparison(message) : undefined;
    if (!text && !observation && !comparison && role !== "tool" && role !== "toolResult") return [];
    return [{
      role,
      text,
      ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
      ...(observation ? { observation } : {}),
      ...(comparison ? { comparison } : {}),
    }];
  });
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function eventLabel(event: PiThreadEvent): string {
  if (event.type === "intent_routed") return event.status === "matched" ? `已匹配 ${event.label ?? "Skill"}` : "未匹配 Skill，进入自由分析";
  if (event.type === "skill_loaded") return event.status === "loaded" ? `已加载 ${event.label ?? "Skill"}` : `${event.label ?? "Skill"} 当前受限`;
  if (event.type === "tool_execution_start") return `${displayToolName(event.toolName)} 已调用`;
  if (event.type === "tool_execution_end") return `${displayToolName(event.toolName)} ${event.status === "failed" ? "失败" : "完成"}`;
  if (event.type === "run_started") return "运行开始";
  if (event.type === "run_completed") return "运行完成";
  if (event.type === "run_failed") return "运行失败";
  return event.type.replaceAll("_", " ");
}

function displayToolName(value?: string): string {
  if (value === "vehicle_aggregate") return "vehicle.aggregate";
  if (value === "vehicle_compare") return "vehicle.compare";
  return value || "受治理工具";
}

function observationValue(value: number | string | null): string {
  if (value === null) return "暂无结果";
  if (typeof value === "number" && Number.isFinite(value)) return new Intl.NumberFormat("zh-CN").format(value);
  return String(value);
}

function observationTime(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : value;
}

function completenessLabel(value: PiVehicleAggregateObservation["completeness"]): string {
  return value === "complete" ? "完整执行" : "结果已截断";
}

function signedValue(value: number | string, unit = ""): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `${String(value)}${unit}`;
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(numeric)}${unit}`;
}

function percentChangeLabel(change: PiVehiclePeriodChange): string {
  if (change.status === "baseline_zero") return "基准期为 0，变化率不适用";
  return signedValue(change.percentChange ?? 0, "%");
}

function directionLabel(direction: PiVehiclePeriodChange["direction"]): string {
  if (direction === "increase") return "增加";
  if (direction === "decrease") return "减少";
  return "持平";
}

function groupKeyLabel(keys: Record<string, string | number | null>): string {
  const fieldLabels: Record<string, string> = {
    "vehicle.dimension.supplier": "供应商",
  };
  return Object.entries(keys)
    .map(([key, value]) => `${fieldLabels[key] ?? key}: ${value ?? "未标注"}`)
    .join(" · ");
}

function organizationAttributionLabel(
  value: PiVehicleAggregateObservation["dataQuality"]["organizationAttribution"],
): string {
  if (value.status === "not_measured") return "组织归属质量：未测量";
  const percentage = value.coverage === null
    ? "-"
    : new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 }).format(value.coverage);
  const counts = value.numerator === null || value.denominator === null
    ? ""
    : ` · ${value.numerator}/${value.denominator}`;
  const range = value.timeRange
    ? ` · ${observationTime(value.timeRange.start)}至${observationTime(value.timeRange.end)}`
    : "";
  const topology = value.topologyVersion ? ` · 拓扑 ${value.topologyVersion}` : "";
  return `组织归属质量：${percentage}${counts}${range}${topology}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof PiAgentApiError) return error.message;
  return error instanceof Error ? error.message : "分析服务请求未完成。";
}

function threadDateGroup(value: string): "today" | "yesterday" | "recent" | "earlier" {
  const updated = new Date(value);
  if (Number.isNaN(updated.valueOf())) return "earlier";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(updated);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today.valueOf() - day.valueOf()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return days <= 6 ? "recent" : "earlier";
}

function groupThreads(items: PiThread[], includePinned: boolean): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  const remaining = includePinned ? items.filter((item) => !item.pinnedAt) : items;
  const pinned = includePinned
    ? items.filter((item) => item.pinnedAt).sort((left, right) => (right.pinnedAt || "").localeCompare(left.pinnedAt || ""))
    : [];
  if (pinned.length) groups.push({ key: "pinned", label: "固定", items: pinned });
  const definitions = [
    { key: "today", label: "今天" },
    { key: "yesterday", label: "昨天" },
    { key: "recent", label: "最近 7 天" },
    { key: "earlier", label: "更早" },
  ] as const;
  for (const definition of definitions) {
    const grouped = remaining.filter((item) => threadDateGroup(item.updatedAt) === definition.key);
    if (grouped.length) groups.push({ ...definition, items: grouped });
  }
  return groups;
}

const projectDefinitions = [
  { key: "rental-comparison", label: "租赁业务对照", matches: (value: string) => /(?:临租|短租).*(?:长租)|(?:长租).*(?:临租|短租)/i.test(value) },
  { key: "management-report", label: "经营分析报告", matches: (value: string) => /报告|经营分析|经营总览/i.test(value) },
  { key: "short-rental", label: "临租业务", matches: (value: string) => /临租|短租/i.test(value) },
  { key: "long-rental", label: "长租业务", matches: (value: string) => /长租/i.test(value) },
  { key: "semantic-data", label: "语义与数据", matches: (value: string) => /ontology|语义|指标|口径|数据库/i.test(value) },
] as const;

function defaultProjectRecords(): ProjectRecord[] {
  return projectDefinitions.map(({ key, label }) => ({ id: key, label, custom: false }));
}

function emptyProjectState(ownerId = ""): ProjectState {
  return { ownerId, projects: defaultProjectRecords(), assignments: {} };
}

function loadProjectState(ownerId: string): ProjectState {
  try {
    const raw = window.localStorage.getItem(`${PROJECTS_STORAGE_PREFIX}.${ownerId}`);
    if (!raw) return emptyProjectState(ownerId);
    const value = JSON.parse(raw) as Partial<ProjectState>;
    const projects = Array.isArray(value.projects)
      ? value.projects.filter((project): project is ProjectRecord => Boolean(project
        && typeof project.id === "string"
        && typeof project.label === "string"
        && typeof project.custom === "boolean"))
      : [];
    const assignments = value.assignments && typeof value.assignments === "object" && !Array.isArray(value.assignments)
      ? Object.fromEntries(Object.entries(value.assignments).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    return { ownerId, projects, assignments };
  } catch {
    return emptyProjectState(ownerId);
  }
}

function groupThreadsByProject(items: PiThread[], state: ProjectState): ThreadGroup[] {
  const available = new Map(state.projects.map((project) => [project.id, project]));
  const grouped = new Map<string, PiThread[]>();
  for (const item of items) {
    const title = item.title || "未命名会话";
    const explicitProject = available.get(state.assignments[item.id] ?? "");
    const inferredProject = projectDefinitions.find((candidate) => candidate.matches(title));
    const key = explicitProject?.id ?? (inferredProject && available.has(inferredProject.key) ? inferredProject.key : "unassigned");
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  const definitions = [...state.projects, { id: "unassigned", label: "未分类", custom: false }];
  return definitions.flatMap((project) => {
    const projectItems = grouped.get(project.id) ?? [];
    if (!projectItems.length && !project.custom) return [];
    return [{
      key: project.id,
      label: project.label,
      items: [...projectItems].sort((left, right) => {
        if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1;
        return right.updatedAt.localeCompare(left.updatedAt);
      }),
    }];
  });
}

function ThreadListItem({
  item, active, archived, editing, editingTitle, onOpen, onArchive, onPin, onStartRename,
  onRenameChange, onCommitRename, onCancelRename, onDelete, projects, assignedProjectId, onMoveProject,
}: {
  item: PiThread; active: boolean; archived: boolean; editing: boolean; editingTitle: string;
  onOpen: () => void; onArchive: () => void; onPin: () => void; onStartRename: () => void;
  // ESLint's base rule does not understand TypeScript callback parameter types.
  // eslint-disable-next-line no-unused-vars
  onRenameChange: (value: string) => void; onCommitRename: () => void; onCancelRename: () => void;
  onDelete: () => void;
  projects?: ProjectRecord[]; assignedProjectId?: string;
  // eslint-disable-next-line no-unused-vars
  onMoveProject?: (projectId: string) => void;
}) {
  const title = item.title || "未命名会话";
  const busy = item.status === "running";
  if (editing) {
    return <form className="thread-rename" onSubmit={(event) => { event.preventDefault(); onCommitRename(); }}>
      <input
        autoFocus
        value={editingTitle}
        maxLength={160}
        aria-label={`重命名会话 ${title}`}
        onChange={(event) => onRenameChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancelRename(); } }}
      />
      <button type="submit" disabled={!editingTitle.trim()} aria-label="保存名称" title="保存名称"><Check aria-hidden="true" /></button>
      <button type="button" onClick={onCancelRename} aria-label="取消重命名" title="取消重命名"><X aria-hidden="true" /></button>
    </form>;
  }
  return <div className={`conversation-item${active ? " is-active" : ""}${busy ? " is-running" : ""}`}>
    <Link to={`/agent/${item.id}`} onClick={onOpen} aria-current={active ? "page" : undefined}>
      <span className="conversation-title">{item.pinnedAt && <Pin aria-hidden="true" />}{title}</span>
      <small><time>{formatTime(item.updatedAt)}</time>{busy && <span>运行中</span>}</small>
    </Link>
    <button
      type="button"
      className="thread-quick-action"
      disabled={busy}
      onClick={onArchive}
      aria-label={`${archived ? "恢复" : "归档"}会话 ${title}`}
      title={archived ? "恢复会话" : "归档会话"}
    >{archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}</button>
    <details className="thread-actions">
      <summary aria-label={`更多会话操作 ${title}`} title="更多操作"><MoreHorizontal aria-hidden="true" /></summary>
      <div>
        {!archived && <button type="button" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onPin(); }}>{item.pinnedAt ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}{item.pinnedAt ? "取消固定" : "固定会话"}</button>}
        {!archived && projects && onMoveProject && <label className="thread-project-select"><span>项目</span><select value={assignedProjectId ?? ""} disabled={busy} onChange={(event) => { onMoveProject(event.target.value); event.currentTarget.closest("details")?.removeAttribute("open"); }}><option value="">自动整理</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.label}</option>)}</select></label>}
        <button type="button" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onStartRename(); }}><PencilLine aria-hidden="true" />重命名</button>
        <button type="button" className="is-destructive" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onDelete(); }}><Trash2 aria-hidden="true" />永久删除</button>
      </div>
    </details>
  </div>;
}

function viewForPath(pathname: string): AgentView {
  if (pathname === "/agent/skills") return "skills";
  if (pathname === "/agent/archived") return "archived";
  if (pathname === "/agent/workspace") return "workspace";
  if (pathname === "/agent/ontology") return "ontology";
  return "chat";
}

function sourceState(source: PiDataSource): string {
  if (source.status === "online") return "在线";
  if (source.status === "offline") return "离线";
  return "未知";
}

function OntologyDocument({ value, kind, query, onKind, onQuery }: {
  value: PiOntologyView | null; kind: PiOntologyKind; query: string;
  // ESLint's base rule does not understand TypeScript callback parameter types.
  // eslint-disable-next-line no-unused-vars
  onKind: (kind: PiOntologyKind) => void; onQuery: (query: string) => void;
}) {
  return (
    <article className="pi-document ontology-document">
      <div className="document-rule" />
      <header className="document-title"><p>正式语义工作区</p><h1>Ontology 语义层</h1><span>{value?.resourceVersion ?? "读取中"}</span></header>
        <div className="ontology-stats" aria-label="Ontology 统计">
          <div><strong>{value?.counts.metrics ?? "-"}</strong><span>指标</span></div>
          <div><strong>{value?.counts.entities ?? "-"}</strong><span>实体</span></div>
          <div><strong>{value?.counts.events ?? "-"}</strong><span>事件</span></div>
          <div><strong>{value?.counts.fields ?? "-"}</strong><span>字段</span></div>
          <div><strong>{value?.counts.relations ?? "-"}</strong><span>关系</span></div>
          <div><strong>{value?.counts.timeSemantics ?? "-"}</strong><span>时间语义</span></div>
      </div>
      <div className="ontology-controls">
        <div className="ontology-tabs" role="tablist" aria-label="语义类型">
          {(Object.keys(kindLabels) as PiOntologyKind[]).map((item) => <button type="button" role="tab" aria-selected={kind === item} key={item} onClick={() => onKind(item)}>{kindLabels[item]}</button>)}
        </div>
        <label className="ontology-search"><Search aria-hidden="true" /><span className="sr-only">搜索语义层</span><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索名称或 semantic ID" /></label>
      </div>
      <div className="ontology-table-wrap">
        <table className="ontology-table">
          <thead><tr><th>名称</th><th>Semantic ID</th><th>口径 / 说明</th><th>状态</th></tr></thead>
          <tbody>{value?.items.map((item) => <tr key={item.id}><td><strong>{item.label}</strong><small>{kindLabels[item.kind]}</small></td><td><code>{item.id}</code></td><td>{item.aggregation ? `${item.aggregation} · ` : ""}{item.description}</td><td><span className={`semantic-status${item.executable === false ? " limited" : ""}`}>{item.executable === false ? "仅语义" : item.status}</span></td></tr>)}</tbody>
        </table>
        {value && value.items.length === 0 && <p className="document-empty">没有匹配的语义项</p>}
      </div>
    </article>
  );
}

function WorkspaceDocument({ workspace }: { workspace: PiWorkspace | null }) {
  return (
    <article className="pi-document data-workspace-document">
      <div className="document-rule" />
      <header className="document-title"><p>只读连接</p><h1>数据库工作区</h1><span>{workspace?.dataSources.length ?? 0} 个工作区</span></header>
      <div className="workspace-source-list">
        {workspace?.dataSources.map((source) => <Link to={source.href} key={source.id} className="workspace-source-row"><span className="source-large-icon">{source.kind === "semantic" ? <Network aria-hidden="true" /> : <Database aria-hidden="true" />}</span><span><strong>{source.label}</strong><small>{source.description}</small></span><span className={`source-state ${source.status}`}><i aria-hidden="true" />{sourceState(source)}</span><ChevronRight aria-hidden="true" /></Link>)}
      </div>
      <section className="workspace-contract"><h2>访问边界</h2><dl><div><dt>查询模式</dt><dd>服务端受治理只读查询</dd></div><div><dt>组织范围</dt><dd>登录 Principal 在服务端注入</dd></div><div><dt>模型访问</dt><dd>仅 semantic ID 与结构化 observation</dd></div></dl></section>
    </article>
  );
}

function SkillsDocument({ skills, activeSkillId, onSelect }: {
  skills: PiSkill[]; activeSkillId: string;
  // eslint-disable-next-line no-unused-vars
  onSelect: (skill: PiSkill) => void;
}) {
  return (
    <article className="pi-document skills-document">
      <div className="document-rule" />
      <header className="document-title"><p>能力目录</p><h1>Skills</h1><span>{skills.length} 项能力</span></header>
      <div className="skill-document-list">
        {skills.map((skill, index) => {
          const Icon = skillIcons[index] ?? Boxes;
          return <button
            type="button"
            className={activeSkillId === skill.id ? "skill-document-row is-active" : "skill-document-row"}
            key={skill.id}
            onClick={() => onSelect(skill)}
            aria-label={`使用 ${skill.label}`}
          >
            <span className="skill-document-icon"><Icon aria-hidden="true" /></span>
            <span className="skill-document-copy"><strong>{skill.label}</strong><small>{skill.summary}</small><span>{skill.toolNames.map(displayToolName).join(" · ")}</span></span>
            <span className={`skill-availability ${skill.status}`}>{skill.status === "available" ? "可用" : "受限"}</span>
            <ArrowUpRight aria-hidden="true" />
          </button>;
        })}
        {skills.length === 0 && <p className="document-empty">当前没有已发布的 Skill</p>}
      </div>
    </article>
  );
}

function ArchivedThreadsDocument({ groups, total, renderItem }: {
  groups: ThreadGroup[]; total: number;
  // eslint-disable-next-line no-unused-vars
  renderItem: (item: PiThread) => ReactNode;
}) {
  return (
    <article className="pi-document archived-document">
      <div className="document-rule" />
      <header className="document-title"><p>会话管理</p><h1>已归档会话</h1><span>{total} 个会话</span></header>
      <div className="archived-thread-list">
        {groups.map((group) => <section className="archived-thread-group" key={group.key}><h2>{group.label}</h2><div>{group.items.map(renderItem)}</div></section>)}
        {groups.length === 0 && <p className="document-empty">暂无归档会话</p>}
      </div>
    </article>
  );
}

function GovernedToolMessage({ message, messageKey }: { message: Extract<DisplayMessage, { role: "tool" | "toolResult" }>; messageKey: string }) {
  if (message.comparison) {
    const comparison = message.comparison;
    const currentPeriod = observationTime(comparison.current.time.value);
    const baselinePeriod = observationTime(comparison.baseline.time.value);
    return <section className="governed-comparison" key={messageKey} aria-label="受治理比较结果">
      <div className="observation-kicker"><GitCompareArrows aria-hidden="true" /><span>受治理周期比较</span><span>{completenessLabel(comparison.completeness)}</span></div>
      <h2>{comparison.label}：{currentPeriod} 对比 {baselinePeriod}</h2>
      {comparison.change
        ? <div className="comparison-summary" aria-label="周期比较摘要">
          <div><span>当前期</span><strong>{observationValue(comparison.current.value)}</strong><small>{currentPeriod} · {comparison.unit}</small></div>
          <div><span>基准期</span><strong>{observationValue(comparison.baseline.value)}</strong><small>{baselinePeriod} · {comparison.unit}</small></div>
          <div data-direction={comparison.change.direction}><span>绝对变化</span><strong>{signedValue(comparison.change.absoluteChange)}</strong><small>{directionLabel(comparison.change.direction)} · {comparison.unit}</small></div>
          <div data-direction={comparison.change.direction}><span>变化率</span><strong>{percentChangeLabel(comparison.change)}</strong><small>服务端确定性计算</small></div>
        </div>
        : <div className="comparison-groups"><table><thead><tr><th>分组</th><th>{currentPeriod}</th><th>{baselinePeriod}</th><th>绝对变化</th><th>变化率</th></tr></thead><tbody>{comparison.groups.map((group, groupIndex) => <tr key={groupIndex}><td>{groupKeyLabel(group.keys)}</td><td>{observationValue(group.currentValue)}</td><td>{observationValue(group.baselineValue)}</td><td data-direction={group.change.direction}>{signedValue(group.change.absoluteChange)}</td><td data-direction={group.change.direction}>{percentChangeLabel(group.change)}</td></tr>)}</tbody></table>{comparison.groups.length === 0 && <p className="comparison-empty">没有可安全比较的完整分组结果。</p>}</div>}
      <p className="comparison-basis">同一正式指标 · 同一登录 Principal 范围 · 同一筛选条件 · ClickHouse 全量聚合</p>
      {(comparison.current.dataQuality.organizationAttribution.status === "not_measured" || comparison.baseline.dataQuality.organizationAttribution.status === "not_measured") && <p className="observation-quality">组织归属质量：未测量；不影响本次查询完整性结论。</p>}
      {comparison.provenance.groupResultTruncated && <p className="observation-quality">分组比较结果已按服务端上限截断。</p>}
    </section>;
  }
  if (message.observation) return <section className="governed-observation" key={messageKey} aria-label="受治理聚合结果">
    <div className="observation-kicker"><ShieldCheck aria-hidden="true" /><span>受治理结果</span><span>{completenessLabel(message.observation.completeness)}</span></div>
    {message.observation.groups.length > 0
      ? <h2>{observationTime(message.observation.time.value)} {message.observation.label}分组结果</h2>
      : <h2>{observationTime(message.observation.time.value)} {message.observation.label}为 <strong>{observationValue(message.observation.value)}</strong> {message.observation.unit}</h2>}
    {message.observation.groups.length > 0 && <div className="observation-groups"><table><thead><tr><th>分组</th><th>数量</th></tr></thead><tbody>{message.observation.groups.map((group, groupIndex) => <tr key={groupIndex}><td>{Object.entries(group.keys).map(([key, value]) => `${key}: ${value ?? "未标注"}`).join(" · ")}</td><td>{observationValue(group.value)}</td></tr>)}</tbody></table></div>}
    <p className="observation-quality">{organizationAttributionLabel(message.observation.dataQuality.organizationAttribution)}</p>
    <p className="observation-provenance">口径 {message.observation.provenance.aggregation} · 服务端组织范围 · ClickHouse 聚合下推 · 来源 {message.observation.provenance.sourceId}</p>
  </section>;
  return <details className="inline-tool" key={messageKey}><summary><Wrench aria-hidden="true" />{displayToolName(message.toolName)}<ChevronDown aria-hidden="true" /></summary><pre>{message.text}</pre></details>;
}

function ConversationDocument({ thread, messages, reportMode, onPrompt }: {
  // eslint-disable-next-line no-unused-vars
  thread: PiThread | null; messages: DisplayMessage[]; reportMode: boolean; onPrompt: (prompt: string) => void;
}) {
  const title = messages.find((item) => item.role === "user")?.text || thread?.title || "新的车辆业务问题";
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  const reportEvidence = reportMode
    ? messages.slice(lastUserIndex + 1).filter((message): message is Extract<DisplayMessage, { role: "tool" | "toolResult" }> => message.role === "tool" || message.role === "toolResult")
    : [];
  return (
    <article className="pi-document conversation-document" data-report-mode={reportMode} aria-live="polite">
      <div className="document-rule" />
      {messages.length === 0 ? <div className="document-empty-state">
        <p>车辆经营数据智能分析</p>
        <h1>车域智析</h1>
        <span>OntoFleet</span>
        <div className="empty-prompt-list" aria-label="常用分析问题">
          {EMPTY_PROMPTS.map((prompt) => <button type="button" key={prompt} onClick={() => onPrompt(prompt)}>{prompt}<ArrowUpRight aria-hidden="true" /></button>)}
        </div>
      </div> : <>
        <header className="document-title"><p>分析问题</p><h1>{title}</h1></header>
        {messages.map((message, index) => {
          if (message.role === "user") return index === 0 ? null : <section className="follow-up-question" key={`${message.role}-${index}`}><p>后续问题</p><h2>{message.text}</h2></section>;
          if (message.role === "tool" || message.role === "toolResult") {
            if (reportMode && index > lastUserIndex) return null;
            return <GovernedToolMessage message={message} messageKey={`${message.role}-${index}`} key={`${message.role}-${index}`} />;
          }
          return <section className="assistant-document" key={`${message.role}-${index}`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown></section>;
        })}
        {reportEvidence.length > 0 && <details className="report-evidence"><summary><span><Database aria-hidden="true" />数据依据</span><small>{reportEvidence.length} 项受治理结果</small><ChevronDown aria-hidden="true" /></summary><div>{reportEvidence.map((message, index) => <GovernedToolMessage message={message} messageKey={`report-evidence-${index}`} key={`report-evidence-${index}`} />)}</div></details>}
        {thread && thread.events.length > 0 && <details className="document-events"><summary><Wrench aria-hidden="true" />工具活动与路由记录<ChevronDown aria-hidden="true" /></summary><div>{thread.events.slice(-16).map((event, index) => <div className="document-event" key={`${event.sequence ?? index}-${event.type}`}><span className={`event-dot ${event.status ?? ""}`} aria-hidden="true" /><span>{eventLabel(event)}</span>{event.at && <time>{formatTime(event.at)}</time>}</div>)}</div></details>}
        {thread?.lastError && <div className="document-error"><CircleAlert aria-hidden="true" />{thread.lastError}</div>}
      </>}
    </article>
  );
}

export default function AgentWorkbench() {
  const { threadId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { principal, markRequired } = useAuth();
  const view = viewForPath(location.pathname);
  const [threads, setThreads] = useState<PiThread[]>([]);
  const [archivedThreads, setArchivedThreads] = useState<PiThread[]>([]);
  const [thread, setThread] = useState<PiThread | null>(null);
  const [config, setConfig] = useState<PiRuntimeConfig | null>(null);
  const [workspace, setWorkspace] = useState<PiWorkspace | null>(null);
  const [ontology, setOntology] = useState<PiOntologyView | null>(null);
  const [ontologyKind, setOntologyKind] = useState<PiOntologyKind>("metric");
  const [ontologyQuery, setOntologyQuery] = useState("");
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [creatingThread, setCreatingThread] = useState(false);
  const [error, setError] = useState("");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [railWidth, setRailWidth] = useState(initialRailWidth);
  const [railResizing, setRailResizing] = useState(false);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [editingThreadId, setEditingThreadId] = useState("");
  const [editingTitle, setEditingTitle] = useState("");
  const [projectState, setProjectState] = useState<ProjectState>(() => emptyProjectState());
  const [editingProjectId, setEditingProjectId] = useState("");
  const [editingProjectName, setEditingProjectName] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const sidebarSearchRef = useRef<HTMLInputElement>(null);
  const railResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try { window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(railWidth)); } catch { /* Preference persistence is optional. */ }
  }, [railWidth]);

  useEffect(() => {
    if (!principal?.id) return;
    setProjectState(loadProjectState(principal.id));
  }, [principal?.id]);

  useEffect(() => {
    if (!principal?.id || projectState.ownerId !== principal.id) return;
    try {
      window.localStorage.setItem(`${PROJECTS_STORAGE_PREFIX}.${principal.id}`, JSON.stringify(projectState));
    } catch { /* Project preferences remain usable for this page lifetime. */ }
  }, [principal?.id, projectState]);

  const refreshThreads = useCallback(async () => {
    const [activeItems, archivedItems] = await Promise.all([
      listPiThreads("active"),
      listPiThreads("archived"),
    ]);
    setThreads(activeItems);
    setArchivedThreads(archivedItems);
    return { activeItems, archivedItems };
  }, []);
  const loadThread = useCallback(async (id: string) => {
    const value = await getPiThread(id); setThread(value); return value;
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void Promise.all([refreshThreads(), getPiRuntimeConfig(), getPiWorkspace(), threadId ? loadThread(threadId) : Promise.resolve(null)])
      .then(([threadLists, runtimeConfig, workspaceValue, loadedThread]) => {
        if (!active) return;
        setConfig(runtimeConfig); setWorkspace(workspaceValue);
        if (!threadId) setThread(null);
        if (threadId && !loadedThread
          && !threadLists.activeItems.some((item) => item.id === threadId)
          && !threadLists.archivedItems.some((item) => item.id === threadId)) {
          setError("此会话不存在，或不属于当前登录用户。");
        }
      }).catch((cause: unknown) => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadThread, refreshThreads, threadId]);

  useEffect(() => {
    if (view !== "ontology") return;
    let active = true;
    const timer = window.setTimeout(() => {
      void getPiOntology(ontologyQuery, ontologyKind).then((value) => { if (active) setOntology(value); })
        .catch((cause: unknown) => { if (active) setError(errorMessage(cause)); });
    }, 150);
    return () => { active = false; window.clearTimeout(timer); };
  }, [ontologyKind, ontologyQuery, view]);

  const messages = useMemo(() => displayMessages(thread), [thread]);
  const routedSkillId = useMemo(() => [...(thread?.events ?? [])].reverse().find((event) => event.type === "intent_routed")?.skillId ?? "", [thread]);
  const activeSkillId = routedSkillId || selectedSkillId;
  const activeSkill = workspace?.skills.find((skill) => skill.id === activeSkillId);
  const sidebarNeedle = sidebarQuery.trim().toLocaleLowerCase("zh-CN");
  const filteredSkills = workspace?.skills.filter((skill) => `${skill.label} ${skill.summary}`.toLocaleLowerCase("zh-CN").includes(sidebarNeedle)) ?? [];
  const threadProjects = useMemo(() => {
    const filtered = threads.filter((item) => (item.title || "未命名会话").toLocaleLowerCase("zh-CN").includes(sidebarNeedle));
    return groupThreadsByProject(filtered, projectState);
  }, [projectState, sidebarNeedle, threads]);
  const archivedGroups = useMemo(() => groupThreads(archivedThreads, false), [archivedThreads]);
  const searchedThreads = useMemo(() => {
    if (!sidebarNeedle) return [];
    return [...threads, ...archivedThreads].filter((item) => (item.title || "未命名会话").toLocaleLowerCase("zh-CN").includes(sidebarNeedle));
  }, [archivedThreads, sidebarNeedle, threads]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true); setError("");
    let activeThread = thread;
    try {
      if (!activeThread) {
        activeThread = await createPiThread(content.slice(0, 80));
        setThreads((current) => [activeThread as PiThread, ...current]);
        navigate(`/agent/${activeThread.id}`);
      }
      setThread({ ...activeThread, status: "running", messages: [...activeThread.messages, { role: "user", content }] });
      await sendPiMessage(activeThread.id, content);
      setDraft(""); await loadThread(activeThread.id); await refreshThreads();
    } catch (cause: unknown) {
      setError(errorMessage(cause));
      try { if (activeThread?.id) await loadThread(activeThread.id); } catch { /* Preserve the original run error. */ }
    } finally { setSending(false); composerRef.current?.focus(); }
  }, [draft, loadThread, navigate, refreshThreads, sending, thread]);

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  }
  async function newConversation() {
    if (creatingThread) return;
    setCreatingThread(true); setError("");
    try {
      const created = await createPiThread("新对话");
      setSidebarSearchOpen(false); setSidebarQuery("");
      setThread(created); setDraft(""); setSelectedSkillId(""); setMobileRailOpen(false);
      setThreads((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      navigate(`/agent/${created.id}`);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setCreatingThread(false);
      window.setTimeout(() => composerRef.current?.focus(), 0);
    }
  }
  async function archiveThread(item: PiThread, archived: boolean) {
    if (item.status === "running") {
      setError("运行中的会话不能归档或删除，请等待本轮结束。");
      return;
    }
    setError("");
    try {
      const updated = await setPiThreadArchived(item.id, archived);
      if (archived) {
        setThreads((current) => current.filter((candidate) => candidate.id !== item.id));
        setArchivedThreads((current) => [updated, ...current.filter((candidate) => candidate.id !== updated.id)]);
      } else {
        setArchivedThreads((current) => current.filter((candidate) => candidate.id !== item.id));
        setThreads((current) => [updated, ...current.filter((candidate) => candidate.id !== updated.id)]);
      }
      if (item.id === threadId) {
        setThread(null);
        navigate("/agent");
      }
      if (archived) {
        toast.success("会话已归档", {
          action: {
            label: "撤销",
            onClick: () => {
              void setPiThreadArchived(item.id, false).then((restored) => {
                setArchivedThreads((current) => current.filter((candidate) => candidate.id !== restored.id));
                setThreads((current) => [restored, ...current.filter((candidate) => candidate.id !== restored.id)]);
                toast.success("已撤销归档");
              }).catch((cause: unknown) => setError(errorMessage(cause)));
            },
          },
        });
      } else {
        toast.success("会话已恢复");
      }
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }
  async function togglePinned(item: PiThread) {
    if (item.status === "running") {
      setError("运行中的会话不能固定，请等待本轮结束。");
      return;
    }
    setError("");
    try {
      const updated = await setPiThreadPinned(item.id, !item.pinnedAt);
      setThreads((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      setArchivedThreads((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      if (thread?.id === updated.id) setThread(updated);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }
  function startRename(item: PiThread) {
    setEditingThreadId(item.id);
    setEditingTitle(item.title || "未命名会话");
  }
  async function commitRename(item: PiThread) {
    const title = editingTitle.trim();
    if (!title || item.status === "running") return;
    setError("");
    try {
      const updated = await renamePiThread(item.id, title);
      setThreads((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      setArchivedThreads((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      if (thread?.id === updated.id) setThread(updated);
      setEditingThreadId("");
      setEditingTitle("");
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }
  async function removeThread(item: PiThread) {
    if (item.status === "running") {
      setError("运行中的会话不能归档或删除，请等待本轮结束。");
      return;
    }
    if (!window.confirm(`永久删除“${item.title || "未命名对话"}”？此操作不可恢复。`)) return;
    setError("");
    try {
      await deletePiThread(item.id);
      setThreads((current) => current.filter((candidate) => candidate.id !== item.id));
      setArchivedThreads((current) => current.filter((candidate) => candidate.id !== item.id));
      if (item.id === threadId) {
        setThread(null);
        navigate("/agent");
      }
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  }
  function chooseSkill(skill: PiSkill) {
    setSelectedSkillId(skill.id); setDraft(skill.prompt); setMobileRailOpen(false); setSidebarSearchOpen(false); setSidebarQuery(""); navigate("/agent");
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }
  function applyPrompt(prompt: string) {
    setDraft(prompt);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }
  function startCreateProject() {
    setEditingProjectId("__new__");
    setEditingProjectName("");
  }
  function startEditProject(project: ProjectRecord) {
    setEditingProjectId(project.id);
    setEditingProjectName(project.label);
  }
  function cancelProjectEdit() {
    setEditingProjectId("");
    setEditingProjectName("");
  }
  function commitProjectEdit() {
    const label = editingProjectName.trim();
    if (!label) return;
    if (projectState.projects.some((project) => project.id !== editingProjectId && project.label === label)) {
      setError("项目名称已存在。");
      return;
    }
    setProjectState((current) => editingProjectId === "__new__"
      ? { ...current, projects: [...current.projects, { id: globalThis.crypto.randomUUID(), label, custom: true }] }
      : { ...current, projects: current.projects.map((project) => project.id === editingProjectId ? { ...project, label } : project) });
    cancelProjectEdit();
  }
  function removeProject(project: ProjectRecord) {
    if (!window.confirm(`删除项目“${project.label}”？项目中的会话不会被删除。`)) return;
    setProjectState((current) => ({
      ...current,
      projects: current.projects.filter((candidate) => candidate.id !== project.id),
      assignments: Object.fromEntries(Object.entries(current.assignments).filter(([, projectId]) => projectId !== project.id)),
    }));
    if (editingProjectId === project.id) cancelProjectEdit();
    toast.success("项目已删除，会话已保留");
  }
  function moveThreadToProject(item: PiThread, projectId: string) {
    setProjectState((current) => {
      const assignments = { ...current.assignments };
      if (projectId) assignments[item.id] = projectId;
      else delete assignments[item.id];
      return { ...current, assignments };
    });
  }
  function toggleSidebarSearch() {
    if (sidebarSearchOpen) {
      setSidebarSearchOpen(false);
      setSidebarQuery("");
      return;
    }
    setSidebarSearchOpen(true);
    window.setTimeout(() => sidebarSearchRef.current?.focus(), 0);
  }
  async function signOut() { try { await logoutSession(); } finally { markRequired(); } }
  function toggleRail() {
    if (window.matchMedia("(max-width: 760px)").matches) setMobileRailOpen((value) => !value);
    else setRailCollapsed((value) => !value);
  }
  function startRailResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (railCollapsed || event.button !== 0) return;
    railResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: railWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setRailResizing(true);
    event.preventDefault();
  }
  function moveRailResize(event: ReactPointerEvent<HTMLDivElement>) {
    const active = railResizeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setRailWidth(constrainRailWidth(active.startWidth + event.clientX - active.startX));
  }
  function finishRailResize(event: ReactPointerEvent<HTMLDivElement>) {
    const active = railResizeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    railResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setRailResizing(false);
  }
  function resizeRailWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 16;
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = railWidth - step;
    if (event.key === "ArrowRight") next = railWidth + step;
    if (event.key === "Home") next = MIN_RAIL_WIDTH;
    if (event.key === "End") next = MAX_RAIL_WIDTH;
    if (next === undefined) return;
    event.preventDefault();
    setRailWidth(constrainRailWidth(next));
  }

  const pageTitle = view === "skills" ? "Skills"
    : view === "archived" ? "已归档会话"
      : view === "ontology" ? "Ontology 语义层"
        : view === "workspace" ? "数据库工作区"
          : thread?.title || "新的车辆业务问题";

  return (
    <section
      className="agent-workbench"
      data-rail-collapsed={railCollapsed}
      data-rail-resizing={railResizing}
      data-view={view}
      style={{ "--rail-expanded-width": `${railWidth}px` } as CSSProperties}
      aria-label="车域智析工作台"
    >
      {mobileRailOpen && <button className="rail-backdrop" type="button" aria-label="关闭导航" onClick={() => setMobileRailOpen(false)} />}
      <aside id="ontofleet-navigation" className={`agent-rail${mobileRailOpen ? " is-mobile-open" : ""}`} aria-label="车域智析导航">
        <div className="rail-content">
          <header className="rail-brand">
            <button type="button" className="brand-home" onClick={() => { setMobileRailOpen(false); navigate("/agent"); }} aria-label="返回车域智析首页">
              <strong>车域智析</strong>
            </button>
            <button type="button" className="rail-search-trigger" onClick={toggleSidebarSearch} aria-label="搜索会话或 Skill" aria-expanded={sidebarSearchOpen} aria-controls="sidebar-search-panel" title="搜索"><Search aria-hidden="true" /></button>
            <button type="button" className="rail-collapse" onClick={toggleRail} aria-label={railCollapsed ? "展开侧栏" : "折叠侧栏"} title={railCollapsed ? "展开侧栏" : "折叠侧栏"}>{railCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}</button>
          </header>
          {sidebarSearchOpen && <div className="rail-search-popover" id="sidebar-search-panel">
            <div className="rail-search-row"><label className="rail-search"><Search aria-hidden="true" /><span className="sr-only">搜索会话或 Skill</span><input ref={sidebarSearchRef} value={sidebarQuery} onChange={(event) => setSidebarQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") toggleSidebarSearch(); }} placeholder="搜索会话或 Skill" /></label><button type="button" onClick={toggleSidebarSearch} aria-label="关闭搜索"><X aria-hidden="true" /></button></div>
            {sidebarNeedle && <div className="rail-search-results" aria-label="搜索结果">
              {filteredSkills.map((skill) => <button type="button" key={skill.id} onClick={() => chooseSkill(skill)}><Boxes aria-hidden="true" /><span><strong>{skill.label}</strong><small>Skill</small></span></button>)}
              {searchedThreads.map((item) => <Link to={`/agent/${item.id}`} key={item.id} onClick={() => { setMobileRailOpen(false); setSidebarSearchOpen(false); setSidebarQuery(""); }}><SquareTerminal aria-hidden="true" /><span><strong>{item.title || "未命名会话"}</strong><small>{item.archivedAt ? "已归档" : "会话"}</small></span></Link>)}
              {filteredSkills.length === 0 && searchedThreads.length === 0 && <p>没有匹配结果</p>}
            </div>}
          </div>}
          <button className="rail-new-conversation" type="button" onClick={() => void newConversation()} disabled={creatingThread} aria-busy={creatingThread}><SquarePen aria-hidden="true" /><span>{creatingThread ? "正在新建" : "新建分析"}</span></button>
          <nav className="rail-primary-navigation" aria-label="主要导航">
            <Link to="/agent/skills" className={view === "skills" ? "is-active" : ""} onClick={() => setMobileRailOpen(false)}><Boxes aria-hidden="true" /><span>Skills</span></Link>
            <Link to="/agent/archived" className={view === "archived" ? "is-active" : ""} onClick={() => setMobileRailOpen(false)}><Archive aria-hidden="true" /><span>已归档会话</span>{archivedThreads.length > 0 && <small>{archivedThreads.length}</small>}</Link>
          </nav>
          <section className="conversation-panel" aria-label="会话列表">
            <header className="conversation-panel-header"><span>会话</span><button type="button" onClick={startCreateProject} aria-label="新建项目" title="新建项目"><Plus aria-hidden="true" /></button></header>
            <div className="conversation-list-scroll">
              <div className="project-list-label">项目</div>
              {editingProjectId === "__new__" && <form className="project-rename" onSubmit={(event) => { event.preventDefault(); commitProjectEdit(); }}><input autoFocus value={editingProjectName} maxLength={48} aria-label="项目名称" placeholder="项目名称" onChange={(event) => setEditingProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") cancelProjectEdit(); }} /><button type="submit" disabled={!editingProjectName.trim()} aria-label="创建项目" title="创建项目"><Check aria-hidden="true" /></button><button type="button" onClick={cancelProjectEdit} aria-label="取消新建项目" title="取消"><X aria-hidden="true" /></button></form>}
              {threadProjects.length === 0 && <p className="conversation-empty">{sidebarNeedle ? "没有匹配的会话" : "暂无会话"}</p>}
              {threadProjects.map((project) => {
                const managedProject = projectState.projects.find((candidate) => candidate.id === project.key);
                if (editingProjectId === project.key && managedProject) return <form className="project-rename" key={project.key} onSubmit={(event) => { event.preventDefault(); commitProjectEdit(); }}><input autoFocus value={editingProjectName} maxLength={48} aria-label={`重命名项目 ${project.label}`} onChange={(event) => setEditingProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") cancelProjectEdit(); }} /><button type="submit" disabled={!editingProjectName.trim()} aria-label="保存项目名称" title="保存"><Check aria-hidden="true" /></button><button type="button" onClick={cancelProjectEdit} aria-label="取消重命名项目" title="取消"><X aria-hidden="true" /></button></form>;
                return <div className="thread-project-shell" key={project.key}>
                  <details className="thread-project" open>
                    <summary><ChevronRight aria-hidden="true" /><Folder aria-hidden="true" /><span>{project.label}</span><small>{project.items.length}</small></summary>
                    <div className="project-thread-tree">{project.items.map((item) => <ThreadListItem
                      key={item.id}
                      item={item}
                      active={item.id === threadId}
                      archived={false}
                      editing={editingThreadId === item.id}
                      editingTitle={editingTitle}
                      onOpen={() => setMobileRailOpen(false)}
                      onArchive={() => void archiveThread(item, true)}
                      onPin={() => void togglePinned(item)}
                      onStartRename={() => startRename(item)}
                      onRenameChange={setEditingTitle}
                      onCommitRename={() => void commitRename(item)}
                      onCancelRename={() => { setEditingThreadId(""); setEditingTitle(""); }}
                      onDelete={() => void removeThread(item)}
                      projects={projectState.projects}
                      {...(projectState.assignments[item.id] ? { assignedProjectId: projectState.assignments[item.id] } : {})}
                      onMoveProject={(projectId) => moveThreadToProject(item, projectId)}
                    />)}</div>
                  </details>
                  {managedProject && <details className="project-actions"><summary aria-label={`管理项目 ${project.label}`} title="项目操作"><MoreHorizontal aria-hidden="true" /></summary><div><button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); startEditProject(managedProject); }}><PencilLine aria-hidden="true" />重命名</button><button type="button" className="is-destructive" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); removeProject(managedProject); }}><Trash2 aria-hidden="true" />删除项目</button></div></details>}
                </div>;
              })}
            </div>
          </section>
          <section className="rail-section database-section" aria-labelledby="database-heading"><header><span id="database-heading">数据库</span></header><div>{workspace?.dataSources.map((source) => <Link to={source.href} key={source.id} className={location.pathname === source.href ? "is-active" : ""} onClick={() => setMobileRailOpen(false)}><ChevronRight aria-hidden="true" /><span className="database-icon">{source.kind === "semantic" ? <Network aria-hidden="true" /> : <Database aria-hidden="true" />}</span><span><strong>{source.label}</strong><small>{source.description}</small></span><i className={`connection-dot ${source.status}`} aria-label={sourceState(source)} /></Link>)}</div></section>
          <details className="workspace-account"><summary><span className="workspace-avatar">{principal?.displayName?.slice(0, 1) || "用"}</span><span><strong>{principal?.displayName || "当前用户"}</strong><small>{principal?.email || "正在读取账号"}</small></span><i aria-hidden="true" /></summary><div><p>{config?.modelId || "运行时连接中"} · {principal?.dataScope || "受治理范围"}</p><button type="button" onClick={() => void signOut()}>退出登录</button></div></details>
        </div>
        <div
          className="agent-rail-resizer"
          role="separator"
          aria-label="调整侧栏宽度"
          aria-controls="ontofleet-navigation"
          aria-orientation="vertical"
          aria-valuemin={MIN_RAIL_WIDTH}
          aria-valuemax={MAX_RAIL_WIDTH}
          aria-valuenow={railWidth}
          tabIndex={0}
          onPointerDown={startRailResize}
          onPointerMove={moveRailResize}
          onPointerUp={finishRailResize}
          onPointerCancel={finishRailResize}
          onLostPointerCapture={() => { railResizeRef.current = null; setRailResizing(false); }}
          onKeyDown={resizeRailWithKeyboard}
          onDoubleClick={() => setRailWidth(constrainRailWidth(DEFAULT_RAIL_WIDTH))}
          title="拖动调整侧栏宽度；双击恢复默认宽度"
        />
      </aside>
      <section className="agent-conversation" aria-label="会话内容">
        <header className="agent-topbar"><button className="mobile-menu" type="button" onClick={() => setMobileRailOpen(true)} aria-label="打开导航" title="打开导航"><Menu aria-hidden="true" /></button><h2>{pageTitle}</h2><span /><div className="readonly-chip"><ShieldCheck aria-hidden="true" />只读</div><button type="button" onClick={() => setContextOpen((value) => !value)} aria-label="切换上下文面板" title="切换上下文面板"><PanelRightOpen aria-hidden="true" /></button></header>
        <div className="agent-document-scroll">
          {loading && <div className="agent-loading"><LoaderCircle aria-hidden="true" />正在读取工作区</div>}
          {!loading && view === "chat" && <ConversationDocument thread={thread} messages={messages} reportMode={routedSkillId === "vehicle.management_report"} onPrompt={applyPrompt} />}
          {!loading && view === "skills" && <SkillsDocument skills={workspace?.skills ?? []} activeSkillId={activeSkillId} onSelect={chooseSkill} />}
          {!loading && view === "archived" && <ArchivedThreadsDocument
            groups={archivedGroups}
            total={archivedThreads.length}
            renderItem={(item) => <ThreadListItem
              key={item.id}
              item={item}
              active={item.id === threadId}
              archived
              editing={editingThreadId === item.id}
              editingTitle={editingTitle}
              onOpen={() => setMobileRailOpen(false)}
              onArchive={() => void archiveThread(item, false)}
              onPin={() => void togglePinned(item)}
              onStartRename={() => startRename(item)}
              onRenameChange={setEditingTitle}
              onCommitRename={() => void commitRename(item)}
              onCancelRename={() => { setEditingThreadId(""); setEditingTitle(""); }}
              onDelete={() => void removeThread(item)}
            />}
          />}
          {!loading && view === "workspace" && <WorkspaceDocument workspace={workspace} />}
          {!loading && view === "ontology" && <OntologyDocument value={ontology} kind={ontologyKind} query={ontologyQuery} onKind={setOntologyKind} onQuery={setOntologyQuery} />}
          {error && <div className="agent-error" role="alert"><CircleAlert aria-hidden="true" />{error}</div>}
        </div>
        {view === "chat" && <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <div className="composer-routing"><span><Sparkles aria-hidden="true" />自动识别意图</span><span><Layers3 aria-hidden="true" />匹配时加载 Skill，否则自由分析</span><i /><span><ShieldCheck aria-hidden="true" />只读访问</span></div>
          <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder="直接描述业务问题，系统会选择 Skill、受治理查询或普通分析..." aria-label="直接描述问题" maxLength={20000} disabled={sending} rows={2} />
          <div className="composer-footer"><span><SquareTerminal aria-hidden="true" />车域智析 · 自动路由 · {config?.modelId || "连接中"}</span><button type="submit" disabled={!draft.trim() || sending} aria-label="发送问题" title="发送问题">{sending ? <LoaderCircle aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}</button></div>
        </form>}
      </section>
      <aside className={`agent-context${contextOpen ? " is-open" : ""}`} aria-label="分析上下文"><header><strong>本轮上下文</strong><button type="button" onClick={() => setContextOpen(false)} aria-label="关闭上下文"><X aria-hidden="true" /></button></header><dl><div><dt>路由模式</dt><dd>自动</dd></div><div><dt>匹配 Skill</dt><dd>{activeSkill?.label || (routedSkillId === "free.analysis" ? "自由分析" : "等待识别")}</dd></div><div><dt>模型</dt><dd>{config?.modelId || "-"}</dd></div><div><dt>推理强度</dt><dd>{config?.thinkingLevel || "-"}</dd></div></dl>{thread?.events.length ? <div className="context-events">{thread.events.slice(-8).map((event, index) => <p key={`${event.sequence ?? index}-${event.type}`}><Check aria-hidden="true" />{eventLabel(event)}</p>)}</div> : null}</aside>
    </section>
  );
}
