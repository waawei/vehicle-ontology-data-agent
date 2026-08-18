import assert from "node:assert/strict";
import test from "node:test";

import { PrincipalResolutionError, PrincipalResolver } from "../src/principal.js";

test("principal resolver forwards the session cookie and keeps the response opaque", async () => {
  let forwardedCookie = "";
  const resolver = new PrincipalResolver("http://agent-api.test", async (_input, init) => {
    forwardedCookie = String(new Headers(init?.headers).get("cookie"));
    return new Response(JSON.stringify({
      id: "user-opaque",
      organizationIds: ["must-not-be-copied"],
      tenantId: "tenant-opaque",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const principal = await resolver.resolve("r6_refresh=session; r6_csrf=csrf");
  assert.equal(forwardedCookie, "r6_refresh=session; r6_csrf=csrf");
  assert.deepEqual(principal, { principalId: "user-opaque" });
  assert.equal("organizationIds" in principal, false);
});

test("principal resolver turns an expired session into an unauthenticated error", async () => {
  const resolver = new PrincipalResolver("http://agent-api.test", async () => new Response("", { status: 401 }));
  await assert.rejects(
    resolver.resolve("r6_refresh=expired"),
    (error: unknown) => error instanceof PrincipalResolutionError && error.code === "UNAUTHENTICATED" && error.statusCode === 401,
  );
});
