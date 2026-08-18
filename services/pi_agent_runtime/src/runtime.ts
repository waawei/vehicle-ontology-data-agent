import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "./config.js";
import { buildRuntimeModel } from "./model.js";
import { OntologyCatalog } from "./ontology.js";
import { createOntologyDescribeTool, createOntologySearchTool } from "./ontology-tool.js";
import type { ThreadOwner } from "./principal.js";
import { nextSequence, type ThreadEvent, type ThreadRecord, ThreadStore } from "./store.js";
import { createVehicleAggregateTool } from "./vehicle-tool.js";
import { createVehicleCompareTool } from "./vehicle-compare-tool.js";
import { routeIntent, runtimeSkill, type RuntimeSkill, type RuntimeToolName } from "./workspace.js";

const BASE_SYSTEM_PROMPT = `你是车辆 Ontology Data Agent。
优先给出业务答案。涉及车辆指标时必须调用受治理工具，禁止猜测表名、字段、组织 ID 或 SQL。
结构化 observation 的 completeness 只表示本次查询是否完整执行；dataQuality.organizationAttribution 是独立的数据质量结论。
当组织归属质量为 not_measured 时，只能说明全局质量尚未测量，不得降低已完整执行查询的 completeness，也不得从本次查询推断全局覆盖率。
工具失败时准确说明外部条件，不得用旧报告、fixture 或示例数字补数。`;

export class PiVehicleRuntime {
  private readonly activeThreads = new Set<string>();

  constructor(
    private readonly config: RuntimeConfig,
    private readonly store: ThreadStore,
    private readonly ontology: OntologyCatalog = OntologyCatalog.empty(),
  ) {}

  async prompt(
    threadId: string,
    content: string,
    cookie: string,
    owner?: ThreadOwner,
  ): Promise<Record<string, unknown>> {
    if (!this.config.apiKey) {
      throw new RuntimeHttpError(
        "PI_AGENT_KEY_UNAVAILABLE",
        "PI_AGENT_API_KEY is not configured",
        503,
      );
    }
    if (this.activeThreads.has(threadId)) {
      throw new RuntimeHttpError("THREAD_BUSY", "Thread already has an active run", 409);
    }
    const thread = await this.store.get(threadId, owner);
    if (thread.archivedAt) {
      throw new RuntimeHttpError("THREAD_ARCHIVED", "Restore the thread before sending a message", 409);
    }
    const previousMessages = [...thread.messages];
    const pendingUserMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: content }],
      timestamp: Date.now(),
    };
    const runId = randomUUID();
    const previousSkillId = [...thread.events].reverse().find((event) => (
      event.type === "intent_routed" && event.skillId && event.skillId !== "free.analysis"
    ))?.skillId;
    const skillRoute = routeIntent(content, previousSkillId ? { previousSkillId } : {});
    const skill = runtimeSkill(skillRoute.skillId);
    const firstEvent = thread.events.length;
    this.activeThreads.add(threadId);
    thread.status = "running";
    thread.activeRunId = runId;
    delete thread.lastError;
    if (!thread.title) thread.title = content.trim().slice(0, 80);
    appendEvent(thread, {
      type: "intent_routed",
      runId,
      skillId: skillRoute.skillId,
      label: skillRoute.label,
      status: skillRoute.matched ? "matched" : "fallback",
    });
    appendEvent(thread, {
      type: "skill_loaded",
      runId,
      skillId: skill.id,
      label: skill.label,
      status: skill.status === "available" ? "loaded" : "limited",
    });
    appendEvent(thread, { type: "run_started", runId, status: "running" });
    thread.messages = [...previousMessages, pendingUserMessage];
    await this.store.save(thread);

    const agent = new Agent({
      initialState: {
        systemPrompt: `${BASE_SYSTEM_PROMPT}\n\n当前 Skill：${skill.label}\n${skill.executionPrompt}`,
        model: buildRuntimeModel(this.config),
        thinkingLevel: this.config.thinkingLevel,
        tools: createToolsForSkill(skill, this.config, cookie, this.ontology),
        messages: previousMessages,
      },
      streamFn: streamSimple,
      sessionId: thread.id,
      getApiKey: async () => this.config.apiKey ?? "",
      toolExecution: "sequential",
    });
    agent.subscribe(async (event) => {
      const summary = summarizeEvent(event, runId);
      if (!summary) return;
      thread.events.push({ sequence: nextSequence(thread), at: new Date().toISOString(), ...summary });
      await this.store.save(thread);
    });

    try {
      await agent.prompt(content);
      thread.messages = [...agent.state.messages];
      const runFailure = extractRunFailure(thread.messages);
      if (runFailure) throw new Error(runFailure);
      thread.status = "idle";
      delete thread.activeRunId;
      appendEvent(thread, { type: "run_completed", runId, status: "completed" });
      await this.store.save(thread);
      return {
        threadId,
        runId,
        status: "completed",
        answer: extractAnswer(thread.messages),
        events: thread.events.slice(firstEvent),
      };
    } catch (error) {
      thread.messages = agent.state.messages.length > previousMessages.length
        ? [...agent.state.messages]
        : [...previousMessages, pendingUserMessage];
      thread.status = "failed";
      delete thread.activeRunId;
      thread.lastError = safeError(error);
      appendEvent(thread, { type: "run_failed", runId, status: "failed" });
      await this.store.save(thread);
      throw new RuntimeHttpError("PI_AGENT_RUN_FAILED", thread.lastError, 502);
    } finally {
      this.activeThreads.delete(threadId);
    }
  }
}

function createToolsForSkill(
  skill: RuntimeSkill,
  config: RuntimeConfig,
  cookie: string,
  ontology: OntologyCatalog,
): AgentTool<any>[] {
  const tools: Record<RuntimeToolName, AgentTool<any>> = {
    ontology_search: createOntologySearchTool(ontology),
    ontology_describe: createOntologyDescribeTool(ontology),
    vehicle_aggregate: createVehicleAggregateTool(config, cookie, fetch, skill.allowedMetricIds),
    vehicle_compare: createVehicleCompareTool(config, cookie, fetch, skill.allowedMetricIds),
  };
  const selected: AgentTool<any>[] = [];
  for (const toolName of skill.toolNames) {
    selected.push(tools[toolName]);
  }
  return selected;
}

export class RuntimeHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function appendEvent(thread: ThreadRecord, event: Omit<ThreadEvent, "sequence" | "at">): void {
  thread.events.push({
    sequence: nextSequence(thread),
    at: new Date().toISOString(),
    ...event,
  });
}

function summarizeEvent(
  event: AgentEvent,
  runId: string,
): Omit<ThreadEvent, "sequence" | "at"> | undefined {
  if (event.type === "tool_execution_start") {
    return { type: event.type, runId, toolName: event.toolName, status: "running" };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: event.type,
      runId,
      toolName: event.toolName,
      status: event.isError ? "failed" : "completed",
    };
  }
  if (new Set(["agent_start", "agent_end", "turn_start", "turn_end", "message_end"]).has(event.type)) {
    return { type: event.type, runId };
  }
  return undefined;
}

function extractAnswer(messages: AgentMessage[]): string {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistant || !Array.isArray(assistant.content)) return "";
  return assistant.content
    .filter((block): block is { type: "text"; text: string } => {
      return block.type === "text" && typeof block.text === "string";
    })
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function extractRunFailure(messages: AgentMessage[]): string | undefined {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistant || assistant.role !== "assistant") return undefined;
  if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") return undefined;
  return assistant.errorMessage || `Pi Agent stopped with ${assistant.stopReason}`;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown Pi Agent runtime error";
  return message.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]").slice(0, 500);
}
