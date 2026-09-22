// A-P1-SHELL：权限域隔离骨架（§8.3 末段；任务卡交付物六——骨架，不实现具体鉴权）。
import { describe, expect, it } from "vitest";
import { type Authenticator, deriveOwnerUserId, type ShellAuth } from "./domains";
import { jsonResponse } from "./errors";
import { createApiShell, type ShellRoute } from "./router";
import { fakeEnv, fakeExecutionContext, siteUrl } from "./test-support";

const userSession: ShellAuth = { kind: "session", domain: "user", userId: "u_1" };
const adminSession: ShellAuth = { kind: "session", domain: "admin", adminId: "adm_1" };

function makeShell(
  auth: ShellAuth,
  routeDomain: "user" | "admin",
  write = false,
): ReturnType<typeof createApiShell> {
  const authenticator: Authenticator = {
    async authenticate() {
      return auth;
    },
  };
  const route: ShellRoute = {
    method: write ? "POST" : "GET",
    pattern: routeDomain === "admin" ? "/api/v2/admin/probe" : "/api/v2/me/probe",
    domain: routeDomain,
    write,
    ...(write
      ? ({
          bodySchema: { fields: {} },
          csrfBinding: async () => "binding",
        } as const)
      : {}),
    handler: async () => jsonResponse({ ok: true }),
  };
  return createApiShell({ authenticator, routes: [route] });
}

describe("A-P1-SHELL 用户/管理员会话域隔离（§8.3）", () => {
  it("用户会话打不开管理路由：401 wrong_domain", async () => {
    const res = await makeShell(userSession, "admin").fetch(
      new Request(siteUrl("/api/v2/admin/probe")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("wrong_domain");
  });

  it("管理员会话不是任何普通用户：打用户路由 → 401 wrong_domain", async () => {
    const res = await makeShell(adminSession, "user").fetch(
      new Request(siteUrl("/api/v2/me/probe")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("wrong_domain");
  });

  it("能力 token（Feed/receipt 类）在会话域路由上只算无身份：401 no_session", async () => {
    const res = await makeShell({ kind: "capability" }, "user").fetch(
      new Request(siteUrl("/api/v2/me/probe")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("no_session");
  });

  it("匹配域的会话正常通行（user→user、admin→admin）", async () => {
    const userRes = await makeShell(userSession, "user").fetch(
      new Request(siteUrl("/api/v2/me/probe")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(userRes.status).toBe(200);
    const adminRes = await makeShell(adminSession, "admin").fetch(
      new Request(siteUrl("/api/v2/admin/probe")),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(adminRes.status).toBe(200);
  });
});

describe("A-P1-SHELL 所有权派生只认 user 域会话（§8.2）", () => {
  it("deriveOwnerUserId：user 会话 → userId；admin/capability/none → null", () => {
    expect(deriveOwnerUserId(userSession)).toBe("u_1");
    expect(deriveOwnerUserId(adminSession)).toBeNull();
    expect(deriveOwnerUserId({ kind: "capability" })).toBeNull();
    expect(deriveOwnerUserId({ kind: "none" })).toBeNull();
  });

  it("管理员会话形状与用户会话不同键（adminId ≠ userId，类型层防误用）", () => {
    expect("userId" in adminSession).toBe(false);
    expect("adminId" in userSession).toBe(false);
  });
});
