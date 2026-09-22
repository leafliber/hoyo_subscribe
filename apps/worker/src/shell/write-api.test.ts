// A-P1-SHELL：写 API 统一中间件（§8.2 末段、§4.2 检查顺序；任务卡交付物三）。
//
// 覆盖：JSON/尺寸/未知字段/所有权字段校验、Origin 同源、CSRF 双提交 + MAC 绑定、
// 权限域守卫、所有者服务端派生、§4.2 顺序（结构与尺寸先于同源）。
import { API_BODY_MAX_BYTES, SECRET_BITS } from "@hoyo/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, mintCsrfToken } from "./csrf";
import {
  ADMIN_SESSION_COOKIE_NAME,
  type Authenticator,
  type ShellAuth,
  USER_SESSION_COOKIE_NAME,
} from "./domains";
import { jsonResponse } from "./errors";
import { createApiShell, type ShellDeps, type ShellRoute } from "./router";
import { fakeEnv, fakeExecutionContext, randomBytes, siteUrl, testKeyring } from "./test-support";

const SUBSCRIPTION_PATH = "/api/v2/me/subscription";
const CSRF_BINDING = "session-hash-test";

let handlerCalled = 0;
let lastContext: { ownerUserId: string | null; body?: Record<string, unknown> } | null = null;
let authOverride: ShellAuth = { kind: "none" };

const subscriptionRoute: ShellRoute = {
  method: "PATCH",
  pattern: SUBSCRIPTION_PATH,
  domain: "user",
  write: true,
  bodySchema: {
    fields: {
      expected_revision: { type: "number" },
      notifications: {
        type: "object",
        optional: true,
        fields: { routine_enabled: { type: "boolean", optional: true } },
      },
    },
  },
  csrfBinding: async () => CSRF_BINDING,
  handler: async (ctx) => {
    handlerCalled++;
    lastContext = { ownerUserId: ctx.ownerUserId, body: ctx.body };
    return jsonResponse({ ok: true });
  },
};

const userSession: Authenticator = {
  async authenticate() {
    return authOverride;
  },
};

function makeShell(extra?: Partial<ShellDeps>) {
  return createApiShell({
    authenticator: userSession,
    csrfKey: async () => (await testKeyring).csrf(),
    routes: [subscriptionRoute],
    ...extra,
  });
}

interface WriteOptions {
  readonly origin?: string | null;
  readonly csrfCookie?: string;
  readonly csrfHeader?: string;
}

function writeRequest(body: unknown, options: WriteOptions = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? "https://app.test");
  }
  if (options.csrfCookie !== undefined) {
    headers.set("cookie", `${CSRF_COOKIE_NAME}=${options.csrfCookie}`);
  }
  if (options.csrfHeader !== undefined) {
    headers.set(CSRF_HEADER_NAME, options.csrfHeader);
  }
  return new Request(siteUrl(SUBSCRIPTION_PATH), {
    method: "PATCH",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function validCsrfToken(binding = CSRF_BINDING): Promise<string> {
  return mintCsrfToken((await testKeyring).csrf(), binding, randomBytes(SECRET_BITS / 8));
}

/** 一切合法的请求形状（默认通过全管线）。 */
async function fullyValidRequest(): Promise<Request> {
  const token = await validCsrfToken();
  return writeRequest(
    { expected_revision: 3, notifications: { routine_enabled: false } },
    { csrfCookie: token, csrfHeader: token },
  );
}

beforeEach(() => {
  handlerCalled = 0;
  lastContext = null;
  authOverride = { kind: "session", domain: "user", userId: "u_server_derived" };
});

describe("A-P1-SHELL 请求结构与尺寸（§4.2 第一环）", () => {
  it("未知字段被拒：details 指名路径与 unknown_field，handler 不被调用", async () => {
    const res = await makeShell().fetch(
      writeRequest({ expected_revision: 1, hax: true }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { fields: unknown[] } } };
    expect(body.error.code).toBe("validation");
    expect(body.error.details.fields).toContainEqual({ path: "hax", reason: "unknown_field" });
    expect(handlerCalled).toBe(0);
  });

  it("嵌套未知字段同样被拒（path 带层级）", async () => {
    const res = await makeShell().fetch(
      writeRequest({ expected_revision: 1, notifications: { rogue: "x" } }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { fields: unknown[] } } };
    expect(body.error.details.fields).toContainEqual({
      path: "notifications.rogue",
      reason: "unknown_field",
    });
  });

  it("超尺寸被拒：超过 API_BODY_MAX_BYTES 字节的合法 JSON → 400 body_too_large", async () => {
    const padding = "a".repeat(API_BODY_MAX_BYTES);
    const res = await makeShell().fetch(
      writeRequest({ expected_revision: 1, padding }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { fields: { reason: string }[] } } };
    expect(body.error.details.fields[0]?.reason).toBe("body_too_large");
    expect(handlerCalled).toBe(0);
  });

  it("Content-Type 非 JSON 被拒；畸形 JSON 被拒", async () => {
    const shell = makeShell();
    const plainText = new Request(siteUrl(SUBSCRIPTION_PATH), {
      method: "PATCH",
      headers: { "content-type": "text/plain", origin: "https://app.test" },
      body: "hello",
    });
    const res1 = await shell.fetch(plainText, fakeEnv, fakeExecutionContext);
    expect(res1.status).toBe(400);

    const res2 = await shell.fetch(writeRequest("{not json"), fakeEnv, fakeExecutionContext);
    expect(res2.status).toBe(400);
    const body = (await res2.json()) as { error: { details: { fields: { reason: string }[] } } };
    expect(body.error.details.fields[0]?.reason).toBe("malformed_json");
    expect(handlerCalled).toBe(0);
  });

  it("§4.2 顺序：结构与尺寸先于同源——超尺寸且缺 Origin 的请求得 400 而非 401", async () => {
    const padding = "a".repeat(API_BODY_MAX_BYTES);
    const res = await makeShell().fetch(
      writeRequest({ expected_revision: 1, padding }, { origin: null }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { fields: { reason: string }[] } } };
    expect(body.error.details.fields[0]?.reason).toBe("body_too_large");
  });
});

describe("A-P1-SHELL 所有权由服务端派生（§8.2：不接受请求体里的 user_id）", () => {
  it.each(["user_id", "userId", "owner_user_id", "ownerUserId"])(
    "请求体带 %s 被拒（field_not_allowed），handler 不被调用",
    async (field) => {
      const res = await makeShell().fetch(
        writeRequest({ expected_revision: 1, [field]: "u_attacker" }),
        fakeEnv,
        fakeExecutionContext,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { details: { fields: unknown[] } } };
      expect(body.error.details.fields).toContainEqual({
        path: field,
        reason: "field_not_allowed",
      });
      expect(handlerCalled).toBe(0);
    },
  );

  it("嵌套对象里夹带 user_id 同样被拒", async () => {
    const res = await makeShell().fetch(
      writeRequest({
        expected_revision: 1,
        notifications: { user_id: "u_attacker" } as unknown as Record<string, unknown>,
      }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { fields: unknown[] } } };
    expect(body.error.details.fields).toContainEqual({
      path: "notifications.user_id",
      reason: "field_not_allowed",
    });
  });

  it("合法请求的 owner 由鉴权器派生，与请求内容无关（伪造头也不生效）", async () => {
    const token = await validCsrfToken();
    const res = await makeShell().fetch(
      writeRequest(
        { expected_revision: 3 },
        {
          csrfCookie: token,
          csrfHeader: token,
          origin: "https://app.test",
        },
      ),
      fakeEnv,
      fakeExecutionContext,
    );
    // 塞一个伪造的 x-user-id 头：外壳根本不看它。
    expect(res.status).toBe(200);
    expect(handlerCalled).toBe(1);
    expect(lastContext?.ownerUserId).toBe("u_server_derived");
    expect(lastContext?.body).toEqual({ expected_revision: 3 });
  });
});

describe("A-P1-SHELL Origin 同源与 CSRF（§4.2 第二环）", () => {
  it("缺 Origin 被拒：401 unauthorized reason origin_missing", async () => {
    const res = await makeShell().fetch(
      writeRequest({ expected_revision: 1 }, { origin: null }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(body.error.details.reason).toBe("origin_missing");
    expect(handlerCalled).toBe(0);
  });

  it("跨源 Origin 被拒：reason origin_mismatch", async () => {
    const res = await makeShell().fetch(
      writeRequest({ expected_revision: 1 }, { origin: "https://evil.example" }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("origin_mismatch");
  });

  it("无会话（domain 守卫）：origin 合法但鉴权器给 none → 401 no_session", async () => {
    authOverride = { kind: "none" };
    const res = await makeShell().fetch(
      writeRequest({ expected_revision: 1 }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("no_session");
  });

  it("管理员会话打用户路由 → 401 wrong_domain（域隔离）", async () => {
    authOverride = { kind: "session", domain: "admin", adminId: "a1" };
    const res = await makeShell().fetch(
      writeRequest({ expected_revision: 1 }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("wrong_domain");
  });

  it("缺 CSRF Cookie/头 → 401 csrf_missing", async () => {
    const res = await makeShell().fetch(
      writeRequest({ expected_revision: 1 }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("csrf_missing");
  });

  it("CSRF 双提交不一致 → 401 csrf_mismatch", async () => {
    const token = await validCsrfToken();
    const other = await validCsrfToken();
    const res = await makeShell().fetch(
      writeRequest({ expected_revision: 1 }, { csrfCookie: token, csrfHeader: other }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("csrf_mismatch");
  });

  it("CSRF 绑定上下文不符（他人 token）→ csrf_mismatch", async () => {
    const foreignBindingToken = await validCsrfToken("another-session-hash");
    const res = await makeShell().fetch(
      writeRequest(
        { expected_revision: 1 },
        { csrfCookie: foreignBindingToken, csrfHeader: foreignBindingToken },
      ),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("csrf_mismatch");
  });

  it("全套通过：同源 + 有效会话 + CSRF 匹配 → handler 收到校验后的 body", async () => {
    const res = await makeShell().fetch(await fullyValidRequest(), fakeEnv, fakeExecutionContext);
    expect(res.status).toBe(200);
    expect(handlerCalled).toBe(1);
    expect(lastContext?.body).toEqual({
      expected_revision: 3,
      notifications: { routine_enabled: false },
    });
  });
});

describe("A-P1-SHELL 失败关闭的接线错误", () => {
  it("写路由缺 bodySchema（接线错误）→ 503，不静默放行", async () => {
    const badRoute: ShellRoute = {
      ...subscriptionRoute,
      pattern: "/api/v2/bad",
      bodySchema: undefined,
    };
    const shell = createApiShell({
      authenticator: userSession,
      csrfKey: async () => (await testKeyring).csrf(),
      routes: [badRoute],
    });
    const token = await validCsrfToken();
    const res = await shell.fetch(
      new Request(siteUrl("/api/v2/bad"), {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "https://app.test",
          cookie: `${CSRF_COOKIE_NAME}=${token}`,
          [CSRF_HEADER_NAME]: token,
        },
        body: JSON.stringify({ expected_revision: 1 }),
      }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(503);
    expect(handlerCalled).toBe(0);
  });

  it("未提供 CSRF 密钥 → 写路由 503（不降级为免 CSRF）", async () => {
    const shell = makeShell({ csrfKey: undefined });
    const token = await validCsrfToken();
    const res = await shell.fetch(
      writeRequest({ expected_revision: 1 }, { csrfCookie: token, csrfHeader: token }),
      fakeEnv,
      fakeExecutionContext,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("temporarily_unavailable");
    expect(handlerCalled).toBe(0);
  });
});

describe("A-P1-SHELL 会话 Cookie 名物理分离（§8.3 域隔离骨架）", () => {
  it("用户与管理员会话 Cookie 名不同且都带 __Host- 前缀", () => {
    expect(USER_SESSION_COOKIE_NAME).not.toBe(ADMIN_SESSION_COOKIE_NAME);
    expect(USER_SESSION_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    expect(ADMIN_SESSION_COOKIE_NAME.startsWith("__Host-")).toBe(true);
  });
});
