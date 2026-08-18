import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nextSequence, ThreadStore } from "../src/store.js";

test("thread state persists and interrupted runs recover as failed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vehicle-pi-store-"));
  try {
    const first = new ThreadStore(root);
    await first.initialize();
    const thread = await first.create("临租订单数");
    thread.status = "running";
    thread.activeRunId = "run-1";
    thread.events.push({
      sequence: nextSequence(thread),
      type: "run_started",
      at: new Date().toISOString(),
      runId: "run-1",
    });
    await first.save(thread);

    const restarted = new ThreadStore(root);
    await restarted.initialize();
    const recovered = await restarted.get(thread.id);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.activeRunId, undefined);
    assert.equal(recovered.events.at(-1)?.type, "run_recovered_as_failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent event saves are serialized without Windows rename failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vehicle-pi-store-concurrent-"));
  try {
    const store = new ThreadStore(root);
    await store.initialize();
    const thread = await store.create("并发保存");
    const saves: Array<Promise<void>> = [];

    for (let sequence = 1; sequence <= 50; sequence += 1) {
      thread.events.push({
        sequence,
        type: "message_end",
        at: new Date().toISOString(),
      });
      saves.push(store.save(thread));
    }

    const readDuringWrites = store.get(thread.id);
    await Promise.all(saves);
    await readDuringWrites;
    const persisted = await store.get(thread.id);
    const files = await readdir(root);

    assert.equal(persisted.events.length, 50);
    assert.equal(persisted.events.at(-1)?.sequence, 50);
    assert.deepEqual(files, [`${thread.id}.json`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("thread ownership isolates principals while preserving legacy TUI threads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vehicle-pi-store-owner-"));
  try {
    const store = new ThreadStore(root);
    await store.initialize();
    const alice = await store.create("Alice", { kind: "principal", principalId: "user-a" });
    const bob = await store.create("Bob", { kind: "principal", principalId: "user-b" });
    const legacy = await store.create("TUI");

    assert.deepEqual((await store.list({ kind: "principal", principalId: "user-a" })).map((item) => item.id), [alice.id]);
    assert.deepEqual((await store.list({ kind: "principal", principalId: "user-b" })).map((item) => item.id), [bob.id]);
    assert.deepEqual((await store.list({ kind: "legacy" })).map((item) => item.id), [legacy.id]);
    await assert.rejects(
      store.get(alice.id, { kind: "principal", principalId: "user-b" }),
      (error: unknown) => error instanceof Error && error.message === "THREAD_NOT_FOUND",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("threads can be archived, restored, and permanently deleted within their owner boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vehicle-pi-store-lifecycle-"));
  const owner = { kind: "principal" as const, principalId: "user-a", tenantId: "tenant-a" };
  try {
    const store = new ThreadStore(root);
    await store.initialize();
    const thread = await store.create("经营分析", owner);

    assert.deepEqual((await store.list(owner, "active")).map((item) => item.id), [thread.id]);
    const renamed = await store.rename(thread.id, "  六月车辆经营分析  ", owner);
    assert.equal(renamed.title, "六月车辆经营分析");
    const pinned = await store.setPinned(thread.id, true, owner);
    assert.equal(typeof pinned.pinnedAt, "string");
    const archived = await store.setArchived(thread.id, true, owner);
    assert.equal(typeof archived.archivedAt, "string");
    assert.equal(archived.pinnedAt, undefined);
    assert.deepEqual(await store.list(owner, "active"), []);
    assert.deepEqual((await store.list(owner, "archived")).map((item) => item.id), [thread.id]);
    await assert.rejects(store.setPinned(thread.id, true, owner), /THREAD_ARCHIVED/);
    await assert.rejects(
      store.setArchived(thread.id, false, { kind: "principal", principalId: "user-b", tenantId: "tenant-a" }),
      (error: unknown) => error instanceof Error && error.message === "THREAD_NOT_FOUND",
    );

    const restored = await store.setArchived(thread.id, false, owner);
    assert.equal(restored.archivedAt, undefined);
    await store.remove(thread.id, owner);
    await assert.rejects(
      store.get(thread.id, owner),
      (error: unknown) => error instanceof Error && error.message === "THREAD_NOT_FOUND",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("running threads cannot mutate lifecycle metadata or be deleted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vehicle-pi-store-running-lifecycle-"));
  try {
    const store = new ThreadStore(root);
    await store.initialize();
    const thread = await store.create("运行中");
    thread.status = "running";
    await store.save(thread);

    await assert.rejects(store.setArchived(thread.id, true), /THREAD_BUSY/);
    await assert.rejects(store.setPinned(thread.id, true), /THREAD_BUSY/);
    await assert.rejects(store.rename(thread.id, "新标题"), /THREAD_BUSY/);
    await assert.rejects(store.remove(thread.id), /THREAD_BUSY/);
    assert.equal((await store.get(thread.id)).status, "running");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
