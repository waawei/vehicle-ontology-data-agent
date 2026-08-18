export type ThreadOwner =
  | { kind: "principal"; principalId: string; tenantId?: string }
  | { kind: "legacy" };

export interface RuntimePrincipal {
  principalId: string;
  tenantId?: string;
}

type FetchLike = typeof fetch;

export class PrincipalResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** Resolves the browser's existing session without exposing identity data to the model. */
export class PrincipalResolver {
  constructor(
    private readonly agentApiUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async resolve(cookie: string): Promise<RuntimePrincipal> {
    if (!cookie.trim()) {
      throw new PrincipalResolutionError(
        "UNAUTHENTICATED",
        "Authentication is required",
        401,
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.agentApiUrl}/auth/me`, {
        method: "GET",
        headers: { accept: "application/json", cookie },
      });
    } catch {
      throw new PrincipalResolutionError(
        "IDENTITY_UNAVAILABLE",
        "Authentication service is unavailable",
        503,
      );
    }

    const payload = await parsePayload(response);
    if (response.status === 401 || response.status === 403) {
      throw new PrincipalResolutionError("UNAUTHENTICATED", "Authentication is required", 401);
    }
    if (!response.ok) {
      throw new PrincipalResolutionError(
        "IDENTITY_UNAVAILABLE",
        "Authentication service rejected the session",
        503,
      );
    }
    if (!isRecord(payload) || typeof payload.id !== "string" || !payload.id.trim()) {
      throw new PrincipalResolutionError(
        "IDENTITY_RESPONSE_INVALID",
        "Authentication service returned an invalid principal",
        503,
      );
    }

    // tenantId is deliberately optional: the public /auth/me contract does not expose it.
    // The opaque principal id is enough to isolate local thread persistence today.
    return { principalId: payload.id };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
