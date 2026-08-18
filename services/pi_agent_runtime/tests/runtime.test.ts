import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRuntimeConfig } from "../src/config.js";
import { PiVehicleRuntime } from "../src/runtime.js";
import { ThreadStore } from "../src/store.js";

test("archived threads must be restored before another prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vehicle-pi-runtime-archived-"));
  try {
    const store = new ThreadStore(root);
    await store.initialize();
    const thread = await store.create("已归档");
    await store.setArchived(thread.id, true);
    const runtime = new PiVehicleRuntime(loadRuntimeConfig({ PI_AGENT_API_KEY: "test-runtime-key" }), store);

    await assert.rejects(() => runtime.prompt(thread.id, "继续分析", ""), /Restore the thread/);
    assert.equal((await store.get(thread.id)).messages.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("official Pi Agent core runs against an OpenAI-compatible streaming endpoint", async () => {
  let authorization = "";
  let requestPayload: Record<string, unknown> | undefined;
  const upstream = createServer((request, response) => {
    authorization = request.headers.authorization || "";
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestPayload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const common = {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1_786_718_000,
        model: "gpt-5.6-terra",
      };
      response.write(
        `data: ${JSON.stringify({
          ...common,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          ...common,
          choices: [{ index: 0, delta: { content: "配置成功" }, finish_reason: null }],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          ...common,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  const root = await mkdtemp(path.join(os.tmpdir(), "vehicle-pi-runtime-"));
  try {
    const store = new ThreadStore(root);
    await store.initialize();
    const thread = await store.create();
    const runtime = new PiVehicleRuntime(
      loadRuntimeConfig({
        PI_AGENT_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        PI_AGENT_API_KEY: "test-runtime-key",
        PI_AGENT_MODEL_ID: "gpt-5.6-terra",
        PI_AGENT_THINKING_LEVEL: "high",
      }),
      store,
    );

    const result = await runtime.prompt(thread.id, "2026 年 6 月临租订单数", "");
    const persisted = await store.get(thread.id);

    assert.equal(result.answer, "配置成功");
    assert.equal(result.status, "completed");
    assert.equal(persisted.status, "idle");
    assert.equal(persisted.messages.length, 2);
    assert.equal(persisted.events.some((event) => event.type === "skill_loaded" && event.skillId === "vehicle.short_rental_analysis"), true);
    assert.equal(authorization, "Bearer test-runtime-key");
    assert.equal(requestPayload?.model, "gpt-5.6-terra");
    assert.equal(requestPayload?.reasoning_effort, "high");
    assert.equal(requestPayload?.max_completion_tokens, 8_192);
    const toolNames = Array.isArray(requestPayload?.tools)
      ? (requestPayload.tools as Array<{ function?: { name?: unknown } }>).map((tool) => tool.function?.name)
      : [];
    assert.deepEqual(toolNames, ["ontology_search", "ontology_describe", "vehicle_aggregate"]);
    assert.equal(JSON.stringify(persisted).includes("test-runtime-key"), false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { recursive: true, force: true });
  }
});

test("provider errors fail the run instead of returning an empty completed answer", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Invalid token" } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  const root = await mkdtemp(path.join(os.tmpdir(), "vehicle-pi-runtime-error-"));
  try {
    const store = new ThreadStore(root);
    await store.initialize();
    const thread = await store.create();
    const runtime = new PiVehicleRuntime(
      loadRuntimeConfig({
        PI_AGENT_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        PI_AGENT_API_KEY: "invalid-test-key",
        PI_AGENT_MODEL_ID: "gpt-5.6-terra",
        PI_AGENT_THINKING_LEVEL: "high",
      }),
      store,
    );

    await assert.rejects(() => runtime.prompt(thread.id, "你好", ""), /401.*Invalid token/s);
    const persisted = await store.get(thread.id);
    assert.equal(persisted.status, "failed");
    assert.match(persisted.lastError || "", /401.*Invalid token/s);
    assert.equal(persisted.events.some((event) => event.type === "run_failed"), true);
    assert.equal(persisted.events.some((event) => event.type === "run_completed"), false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { recursive: true, force: true });
  }
});

test("the user question is durable before the provider finishes", async () => {
  let requestArrivedResolve: (() => void) | undefined;
  let releaseResponse: (() => void) | undefined;
  const requestArrived = new Promise<void>((resolve) => { requestArrivedResolve = resolve; });
  const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requestArrivedResolve?.();
      void responseReleased.then(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const common = { id: "chatcmpl-durable", object: "chat.completion.chunk", created: 1_786_718_000, model: "gpt-5.6-terra" };
        response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { content: "已记录" }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  const root = await mkdtemp(path.join(os.tmpdir(), "vehicle-pi-runtime-durable-"));
  try {
    const store = new ThreadStore(root);
    await store.initialize();
    const thread = await store.create();
    const runtime = new PiVehicleRuntime(
      loadRuntimeConfig({
        PI_AGENT_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        PI_AGENT_API_KEY: "test-runtime-key",
      }),
      store,
    );

    const prompt = runtime.prompt(thread.id, "2026 年 6 月临租订单数", "");
    await requestArrived;
    const running = await store.get(thread.id);
    assert.equal(running.status, "running");
    assert.equal(running.messages.length, 1);
    assert.match(JSON.stringify(running.messages[0]), /2026 年 6 月临租订单数/);

    releaseResponse?.();
    await prompt;
    const completed = await store.get(thread.id);
    assert.equal(completed.messages.length, 2);
  } finally {
    releaseResponse?.();
    await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
