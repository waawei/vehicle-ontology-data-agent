import { fileURLToPath } from "node:url";
import path from "node:path";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface RuntimeConfig {
  host: string;
  port: number;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  modelName: string;
  contextWindow: number;
  maxTokens: number;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  agentApiUrl: string;
  dataDir: string;
  semanticIndexPath: string;
  clickHouseStatus: "online" | "offline" | "unknown";
  corsOrigins: ReadonlySet<string>;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Integer configuration must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function httpUrl(value: string, name: string): string {
  const parsed = new URL(value);
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTP(S) URL without embedded credentials`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const thinking = env.PI_AGENT_THINKING_LEVEL?.trim() || "high";
  if (!new Set(["off", "minimal", "low", "medium", "high", "xhigh"]).has(thinking)) {
    throw new Error("PI_AGENT_THINKING_LEVEL is invalid");
  }
  const rawDataDir = env.PI_AGENT_DATA_DIR?.trim() || "runtime/pi-agent";
  const rawSemanticIndex = env.PI_AGENT_SEMANTIC_INDEX_PATH?.trim() || "semantic/semantic-index.json";
  const clickHouseStatus = env.PI_AGENT_CLICKHOUSE_STATUS?.trim() || "offline";
  if (!new Set(["online", "offline", "unknown"]).has(clickHouseStatus)) {
    throw new Error("PI_AGENT_CLICKHOUSE_STATUS is invalid");
  }
  const apiKey = env.PI_AGENT_API_KEY?.trim();
  return {
    host: env.PI_AGENT_HOST?.trim() || "127.0.0.1",
    port: integer(env.PI_AGENT_PORT, 8091, 1024, 65535),
    baseUrl: httpUrl(
      env.PI_AGENT_BASE_URL?.trim() || "https://provider.example.test/v1",
      "PI_AGENT_BASE_URL",
    ),
    ...(apiKey ? { apiKey } : {}),
    modelId: env.PI_AGENT_MODEL_ID?.trim() || "gpt-5.6-terra",
    modelName: env.PI_AGENT_MODEL_NAME?.trim() || "GPT-5.6 Terra",
    contextWindow: integer(env.PI_AGENT_CONTEXT_WINDOW, 128_000, 8_192, 2_000_000),
    maxTokens: integer(env.PI_AGENT_MAX_TOKENS, 8_192, 256, 128_000),
    thinkingLevel: thinking as RuntimeConfig["thinkingLevel"],
    agentApiUrl: httpUrl(env.PI_AGENT_TOOL_API_URL?.trim() || "http://127.0.0.1:8090", "PI_AGENT_TOOL_API_URL"),
    dataDir: path.isAbsolute(rawDataDir)
      ? rawDataDir
      : path.resolve(REPOSITORY_ROOT, rawDataDir),
    semanticIndexPath: path.isAbsolute(rawSemanticIndex)
      ? rawSemanticIndex
      : path.resolve(REPOSITORY_ROOT, rawSemanticIndex),
    clickHouseStatus: clickHouseStatus as RuntimeConfig["clickHouseStatus"],
    corsOrigins: new Set(
      (env.PI_AGENT_CORS_ORIGINS || "http://127.0.0.1:5180,http://localhost:5180")
        .split(",")
        .map((value) => value.trim().replace(/\/$/, ""))
        .filter(Boolean),
    ),
  };
}

export function publicConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    runtime: "pi-agent-core",
    provider: "openai-compatible",
    modelId: config.modelId,
    modelName: config.modelName,
    thinkingLevel: config.thinkingLevel,
    reasoningEnabled: config.thinkingLevel !== "off",
    reasoningEffortParameter: "reasoning_effort",
    keyConfigured: Boolean(config.apiKey),
    persistence: "local-json",
  };
}
