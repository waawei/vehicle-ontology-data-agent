export interface RuntimeThread {
  id: string;
  title?: string;
  status: string;
  messages?: unknown[];
  events?: unknown[];
}

export interface RuntimePromptResult {
  threadId: string;
  runId: string;
  status: string;
  answer: string;
  events: Array<Record<string, unknown>>;
}

export class RuntimeClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

export class PiRuntimeClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl = process.env.PI_AGENT_RUNTIME_URL || "http://127.0.0.1:8091",
    private readonly cookie = "",
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new RuntimeClientError(
        "RUNTIME_URL_INVALID",
        "PI_AGENT_RUNTIME_URL must be an HTTP(S) URL without embedded credentials",
      );
    }
    this.baseUrl = parsed.toString().replace(/\/$/, "");
  }

  async ensureReady(): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/health/ready`, {
      method: "GET",
      headers: this.headers(),
    });
    if (response.ok) return;
    const payload = await parsePayload(response);
    const message = readErrorMessage(payload) || "Pi Agent runtime is not ready";
    throw new RuntimeClientError("RUNTIME_NOT_READY", message, response.status);
  }

  async createThread(title = "Pi Agent TUI"): Promise<RuntimeThread> {
    const payload = await this.request("/threads", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    if (!isRecord(payload) || typeof payload.id !== "string") {
      throw new RuntimeClientError("RUNTIME_RESPONSE_INVALID", "Runtime returned an invalid thread");
    }
    return payload as unknown as RuntimeThread;
  }

  async prompt(threadId: string, content: string): Promise<RuntimePromptResult> {
    const payload = await this.request(`/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    if (
      !isRecord(payload) ||
      typeof payload.threadId !== "string" ||
      typeof payload.runId !== "string" ||
      typeof payload.answer !== "string"
    ) {
      throw new RuntimeClientError("RUNTIME_RESPONSE_INVALID", "Runtime returned an invalid run result");
    }
    return {
      threadId: payload.threadId,
      runId: payload.runId,
      status: typeof payload.status === "string" ? payload.status : "completed",
      answer: payload.answer,
      events: Array.isArray(payload.events)
        ? payload.events.filter(isRecord)
        : [],
    };
  }

  private async request(pathname: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...this.headers(),
        ...(init.headers || {}),
      },
    });
    const payload = await parsePayload(response);
    if (!response.ok) {
      const error = readError(payload);
      throw new RuntimeClientError(
        error.code,
        error.message,
        response.status,
      );
    }
    return payload;
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "x-pi-agent-client": "tui",
      ...(this.cookie ? { cookie: this.cookie } : {}),
    };
  }
}

async function parsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function readError(payload: unknown): { code: string; message: string } {
  if (isRecord(payload) && isRecord(payload.error)) {
    return {
      code: typeof payload.error.code === "string" ? payload.error.code : "RUNTIME_REQUEST_FAILED",
      message:
        typeof payload.error.message === "string"
          ? payload.error.message
          : "Pi Agent runtime request failed",
    };
  }
  return { code: "RUNTIME_REQUEST_FAILED", message: "Pi Agent runtime request failed" };
}

function readErrorMessage(payload: unknown): string | undefined {
  if (isRecord(payload) && typeof payload.status === "string") {
    if (payload.status === "not_ready") {
      return "Pi Agent runtime is not ready; configure a rotated key and restart it first";
    }
  }
  return readError(payload).message;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
