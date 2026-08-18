import assert from "node:assert/strict";
import test from "node:test";

import { PiRuntimeClient, RuntimeClientError } from "../src/tui-client.js";

test("runtime client forwards only the session cookie and creates a thread", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ id: "thread-1", status: "idle" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  const client = new PiRuntimeClient("http://127.0.0.1:8091/", "session=opaque", fetchImpl);
  const thread = await client.createThread("Local TUI");

  assert.equal(thread.id, "thread-1");
  assert.equal(calls[0]?.url, "http://127.0.0.1:8091/threads");
  assert.equal(calls[0]?.init?.headers && (calls[0]?.init?.headers as Record<string, string>).cookie, "session=opaque");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { title: "Local TUI" });
});

test("runtime client returns structured prompt results", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        threadId: "thread-1",
        runId: "run-1",
        status: "completed",
        answer: "2026 年 6 月临租订单数暂不可用。",
        events: [{ type: "tool_execution_start", toolName: "vehicle.aggregate" }],
      }),
      { status: 200 },
    );
  };
  const client = new PiRuntimeClient("http://127.0.0.1:8091", "", fetchImpl);
  const result = await client.prompt("thread-1", "2026 年 6 月，查询临租订单数");

  assert.equal(result.runId, "run-1");
  assert.equal(result.answer, "2026 年 6 月临租订单数暂不可用。");
  assert.equal(result.events[0]?.toolName, "vehicle.aggregate");
});

test("runtime client explains a missing server key without exposing credentials", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response(JSON.stringify({ status: "not_ready", keyConfigured: false }), {
      status: 503,
    });
  };
  const client = new PiRuntimeClient("http://127.0.0.1:8091", "", fetchImpl);

  await assert.rejects(
    () => client.ensureReady(),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeClientError);
      assert.equal(error.code, "RUNTIME_NOT_READY");
      assert.match(error.message, /configure a rotated key/i);
      assert.doesNotMatch(error.message, /sk-/i);
      return true;
    },
  );
});

test("runtime client rejects URLs with embedded credentials", () => {
  assert.throws(
    () => new PiRuntimeClient("https://user:password@example.test/v1"),
    (error: unknown) => error instanceof RuntimeClientError && error.code === "RUNTIME_URL_INVALID",
  );
});
