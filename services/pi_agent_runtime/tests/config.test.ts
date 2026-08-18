import assert from "node:assert/strict";
import test from "node:test";

import { loadRuntimeConfig, publicConfig } from "../src/config.js";
import { buildRuntimeModel } from "../src/model.js";

test("custom OpenAI-compatible endpoint is configured without exposing its key", () => {
  const config = loadRuntimeConfig({
    PI_AGENT_BASE_URL: "https://provider.example.test/v1",
    PI_AGENT_API_KEY: "test-secret-value",
    PI_AGENT_MODEL_ID: "gpt-5.6-terra",
    PI_AGENT_THINKING_LEVEL: "high",
  });
  const model = buildRuntimeModel(config);
  const visible = publicConfig(config);

  assert.equal(model.baseUrl, "https://provider.example.test/v1");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.id, "gpt-5.6-terra");
  assert.equal(model.reasoning, true);
  assert.equal(model.compat?.supportsReasoningEffort, true);
  assert.equal(visible.thinkingLevel, "high");
  assert.equal(visible.reasoningEnabled, true);
  assert.equal(visible.reasoningEffortParameter, "reasoning_effort");
  assert.equal(visible.keyConfigured, true);
  assert.equal(JSON.stringify(visible).includes("test-secret-value"), false);
  assert.equal("baseUrl" in visible, false);
  assert.equal("toolApiUrl" in visible, false);
});

test("runtime can start unconfigured and reports the missing key safely", () => {
  const config = loadRuntimeConfig({});
  assert.equal(config.apiKey, undefined);
  assert.equal(config.modelId, "gpt-5.6-terra");
  assert.equal(config.thinkingLevel, "high");
  assert.equal(publicConfig(config).keyConfigured, false);
});
