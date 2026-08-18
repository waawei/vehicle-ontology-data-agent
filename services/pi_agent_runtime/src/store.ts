import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ThreadOwner } from "./principal.js";

export type ThreadStatus = "idle" | "running" | "failed";
export type ThreadListState = "active" | "archived" | "all";

export interface ThreadEvent {
  sequence: number;
  type: string;
  at: string;
  runId?: string;
  toolName?: string;
  skillId?: string;
  label?: string;
  status?: string;
}

export interface ThreadRecord {
  schemaVersion: "pi-thread.v1";
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  status: ThreadStatus;
  ownerKind?: "principal" | "legacy";
  principalId?: string;
  tenantId?: string;
  activeRunId?: string;
  lastError?: string;
  archivedAt?: string;
  pinnedAt?: string;
  messages: AgentMessage[];
  events: ThreadEvent[];
}

const THREAD_ID = /^[a-f0-9-]{36}$/;

export class ThreadStore {
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.recoverInterruptedThreads();
  }

  async create(title?: string, owner?: ThreadOwner): Promise<ThreadRecord> {
    const now = new Date().toISOString();
    const thread: ThreadRecord = {
      schemaVersion: "pi-thread.v1",
      id: randomUUID(),
      ...(title?.trim() ? { title: title.trim().slice(0, 160) } : {}),
      createdAt: now,
      updatedAt: now,
      status: "idle",
      ...(owner?.kind === "principal"
        ? {
            ownerKind: "principal" as const,
            principalId: owner.principalId,
            ...(owner.tenantId ? { tenantId: owner.tenantId } : {}),
          }
        : {}),
      messages: [],
      events: [],
    };
    await this.save(thread);
    return thread;
  }

  async get(id: string, owner?: ThreadOwner): Promise<ThreadRecord> {
    const file = this.threadPath(id);
    await this.waitForPendingWrite(id);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new StoreError("THREAD_NOT_FOUND", 404);
      }
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (!isThreadRecord(value) || value.id !== id) {
      throw new StoreError("THREAD_STORE_INVALID", 503);
    }
    if (owner && !canAccess(value, owner)) {
      // Do not reveal whether another principal owns the thread.
      throw new StoreError("THREAD_NOT_FOUND", 404);
    }
    return value;
  }

  async list(owner?: ThreadOwner, state: ThreadListState = "active"): Promise<ThreadRecord[]> {
    const names = (await readdir(this.root)).filter((name) => name.endsWith(".json"));
    const threads: ThreadRecord[] = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      if (!THREAD_ID.test(id)) continue;
      try {
        const thread = await this.get(id);
        const owned = !owner || canAccess(thread, owner);
        const included = state === "all"
          || (state === "archived" ? Boolean(thread.archivedAt) : !thread.archivedAt);
        if (owned && included) threads.push(thread);
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
      }
    }
    return threads.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async setArchived(id: string, archived: boolean, owner?: ThreadOwner): Promise<ThreadRecord> {
    const thread = await this.get(id, owner);
    if (thread.status === "running") throw new StoreError("THREAD_BUSY", 409);
    if (archived) {
      thread.archivedAt = new Date().toISOString();
      delete thread.pinnedAt;
    }
    else delete thread.archivedAt;
    await this.save(thread);
    return thread;
  }

  async setPinned(id: string, pinned: boolean, owner?: ThreadOwner): Promise<ThreadRecord> {
    const thread = await this.get(id, owner);
    if (thread.status === "running") throw new StoreError("THREAD_BUSY", 409);
    if (pinned && thread.archivedAt) throw new StoreError("THREAD_ARCHIVED", 409);
    if (pinned) thread.pinnedAt = new Date().toISOString();
    else delete thread.pinnedAt;
    await this.save(thread);
    return thread;
  }

  async rename(id: string, title: string, owner?: ThreadOwner): Promise<ThreadRecord> {
    const thread = await this.get(id, owner);
    if (thread.status === "running") throw new StoreError("THREAD_BUSY", 409);
    const normalized = title.trim();
    if (!normalized || normalized.length > 160) throw new StoreError("THREAD_TITLE_INVALID", 422);
    thread.title = normalized;
    await this.save(thread);
    return thread;
  }

  async remove(id: string, owner?: ThreadOwner): Promise<void> {
    const thread = await this.get(id, owner);
    if (thread.status === "running") throw new StoreError("THREAD_BUSY", 409);
    await this.waitForPendingWrite(id);
    try {
      await unlink(this.threadPath(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new StoreError("THREAD_NOT_FOUND", 404);
      }
      throw error;
    }
  }

  async save(thread: ThreadRecord): Promise<void> {
    const file = this.threadPath(thread.id);
    thread.updatedAt = new Date().toISOString();
    thread.events = thread.events.slice(-1_000);
    const payload = `${JSON.stringify(thread, null, 2)}\n`;
    const previous = this.pendingWrites.get(thread.id) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => writeFile(file, payload, { encoding: "utf8" }));
    this.pendingWrites.set(thread.id, pending);
    try {
      await pending;
    } finally {
      if (this.pendingWrites.get(thread.id) === pending) {
        this.pendingWrites.delete(thread.id);
      }
    }
  }

  private async waitForPendingWrite(id: string): Promise<void> {
    try {
      await this.pendingWrites.get(id);
    } catch {
      // The save caller receives the write error; readers can still inspect the last durable state.
    }
  }

  private threadPath(id: string): string {
    if (!THREAD_ID.test(id)) throw new StoreError("THREAD_ID_INVALID", 422);
    return path.join(this.root, `${id}.json`);
  }

  private async recoverInterruptedThreads(): Promise<void> {
    const names = (await readdir(this.root)).filter((name) => name.endsWith(".json"));
    for (const name of names) {
      const id = name.slice(0, -5);
      if (!THREAD_ID.test(id)) continue;
      let thread: ThreadRecord;
      try {
        thread = await this.get(id);
      } catch {
        continue;
      }
      if (thread.status !== "running") continue;
      const runId = thread.activeRunId;
      thread.status = "failed";
      thread.lastError = "Run was interrupted by a runtime restart";
      delete thread.activeRunId;
      thread.events.push({
        sequence: nextSequence(thread),
        type: "run_recovered_as_failed",
        at: new Date().toISOString(),
        ...(runId ? { runId } : {}),
        status: "failed",
      });
      await this.save(thread);
    }
  }
}

export class StoreError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(code);
  }
}

export function nextSequence(thread: ThreadRecord): number {
  return (thread.events.at(-1)?.sequence ?? 0) + 1;
}

function isThreadRecord(value: unknown): value is ThreadRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ThreadRecord>;
  return (
    candidate.schemaVersion === "pi-thread.v1" &&
    typeof candidate.id === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    new Set(["idle", "running", "failed"]).has(String(candidate.status)) &&
    Array.isArray(candidate.messages) &&
    Array.isArray(candidate.events) &&
    (candidate.ownerKind === undefined || candidate.ownerKind === "principal" || candidate.ownerKind === "legacy") &&
    (candidate.principalId === undefined || typeof candidate.principalId === "string") &&
    (candidate.tenantId === undefined || typeof candidate.tenantId === "string") &&
    (candidate.archivedAt === undefined || typeof candidate.archivedAt === "string") &&
    (candidate.pinnedAt === undefined || typeof candidate.pinnedAt === "string")
  );
}

function canAccess(thread: ThreadRecord, owner: ThreadOwner): boolean {
  const kind = thread.ownerKind ?? (thread.principalId ? "principal" : "legacy");
  if (owner.kind === "legacy") return kind === "legacy";
  return (
    kind === "principal" &&
    thread.principalId === owner.principalId &&
    (owner.tenantId === undefined || thread.tenantId === undefined || thread.tenantId === owner.tenantId)
  );
}
