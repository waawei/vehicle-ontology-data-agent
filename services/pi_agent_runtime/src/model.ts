import type { Model } from "@earendil-works/pi-ai";

import type { RuntimeConfig } from "./config.js";

export function buildRuntimeModel(config: RuntimeConfig): Model<"openai-completions"> {
  return {
    id: config.modelId,
    name: config.modelName,
    api: "openai-completions",
    provider: "vehicle-openai-compatible",
    baseUrl: config.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsStrictMode: false,
      maxTokensField: "max_completion_tokens",
    },
  };
}
