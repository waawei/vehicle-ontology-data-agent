export type Principal = {
  id: string;
  email: string;
  displayName: string;
  permissions: string[];
  dataScope: string;
};

export type RegisterInput = {
  email: string;
  password: string;
  displayName: string;
  tenantName: string;
};

type ErrorDetail = { code?: string; message?: string };
type ErrorBody = ErrorDetail & { error?: ErrorDetail };

export class AuthApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function csrfToken() {
  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("r6_csrf="));
  return cookie ? decodeURIComponent(cookie.slice("r6_csrf=".length)) : "";
}

async function request<T>(path: string, init?: Parameters<typeof fetch>[1]): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body) headers.set("Content-Type", "application/json");
  if (init?.method && init.method !== "GET") headers.set("X-CSRF-Token", csrfToken());

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "include" });
  } catch {
    throw new AuthApiError(0, "AUTH_UNAVAILABLE", "认证服务暂时不可用，请稍后重试。");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ErrorBody;
    const detail = body.error ?? body;
    throw new AuthApiError(response.status, detail.code ?? "AUTH_FAILED", detail.message ?? "认证未完成。");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function getCurrentPrincipal(signal?: AbortSignal) {
  return request<Principal>("/auth/me", {
    method: "GET",
    ...(signal ? { signal } : {}),
  });
}

export function login(email: string, password: string) {
  return request<Principal>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function register(input: RegisterInput) {
  return request<Principal>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function logout() {
  return request<void>("/auth/logout", { method: "POST" });
}
