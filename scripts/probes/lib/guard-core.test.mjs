// A-P0-PROBE · 探针守卫与限制信号识别的单元测试（L1，纯函数）
// 运行：node --test scripts/probes/lib/
// 注意：这些测试只验证探针工具自身的逻辑，不构成 G-P0 放行证据（那是 E3，需目标环境实测）。

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  analyzeRestrictionSignals,
  assertAllowedUrl,
  GuardError,
  matchMarkers,
  readBodyCapped,
  shallowJsonEnvelope,
} from "./guard-core.mjs";

describe("A-P0-PROBE assertAllowedUrl 域名/协议/凭据守卫", () => {
  it("白名单外的主机被拒绝", () => {
    assert.throws(
      () => assertAllowedUrl("https://evil.example.com/x", ["hk4e-ann-api.mihoyo.com"]),
      (e) => e instanceof GuardError && e.code === "host_not_in_allowlist",
    );
  });

  it("默认拒绝 http，显式放行时允许（供测试）", () => {
    assert.throws(
      () => assertAllowedUrl("http://127.0.0.1/x", ["127.0.0.1"]),
      (e) => e instanceof GuardError && e.code === "scheme_not_allowed",
    );
    const url = assertAllowedUrl("http://127.0.0.1/x", ["127.0.0.1"], { allowInsecureHttp: true });
    assert.equal(url.hostname, "127.0.0.1");
  });

  it("携带 userinfo 的 URL 被拒绝", () => {
    assert.throws(
      () =>
        assertAllowedUrl("https://user:pass@hk4e-ann-api.mihoyo.com/x", [
          "hk4e-ann-api.mihoyo.com",
        ]),
      (e) => e instanceof GuardError && e.code === "userinfo_not_allowed",
    );
  });
});

describe("A-P0-PROBE analyzeRestrictionSignals 限制信号识别（启发式）", () => {
  it("401/403/407/429 状态码被识别为受限信号", () => {
    for (const status of [401, 403, 407, 429]) {
      const r = analyzeRestrictionSignals({ status, headers: {}, bodyText: "" });
      assert.equal(r.restricted, true, `status=${status}`);
      assert.equal(r.signals[0].kind, "http_status");
    }
  });

  it("WWW-Authenticate / cf-mitigated 头被识别", () => {
    const r = analyzeRestrictionSignals({
      status: 200,
      headers: { www_authenticate: "Bearer", cf_mitigated: "challenge" },
      bodyText: "",
    });
    assert.deepEqual(r.signals.map((s) => s.kind).sort(), ["cf_mitigated", "www_authenticate"]);
  });

  it("JSON 顶层信封中的未登录标记被识别", () => {
    const body = JSON.stringify({ retcode: -100, message: "请登录后重试" });
    const r = analyzeRestrictionSignals({
      status: 200,
      headers: {},
      bodyText: body,
      contentType: "application/json",
    });
    assert.equal(r.restricted, true);
    assert.equal(r.signals[0].kind, "body_envelope_marker");
  });

  it("内容数组深处的『每日登录奖励』不触发误报（只扫顶层信封）", () => {
    const body = JSON.stringify({
      retcode: 0,
      message: "OK",
      data: { list: [{ title: "每日登录奖励领取提醒", content: "登录游戏即可领取" }] },
    });
    const r = analyzeRestrictionSignals({
      status: 200,
      headers: {},
      bodyText: body,
      contentType: "application/json",
    });
    assert.equal(r.restricted, false, JSON.stringify(r.signals));
  });

  it("干净的正常 JSON 响应不被标记", () => {
    const body = JSON.stringify({ retcode: 0, message: "OK", data: { list: [] }, total: 3 });
    const r = analyzeRestrictionSignals({
      status: 200,
      headers: {},
      bodyText: body,
      contentType: "application/json",
    });
    assert.equal(r.restricted, false);
  });

  it("非 JSON（HTML 验证页）前缀中的 geetest/captcha 被识别", () => {
    const html = '<html><body><div id="geetest"></div><input name="captcha"></body></html>';
    const r = analyzeRestrictionSignals({
      status: 200,
      headers: {},
      bodyText: html,
      contentType: "text/html",
    });
    assert.equal(r.restricted, true);
    assert.equal(r.signals[0].kind, "body_prefix_marker");
  });

  it("matchMarkers 对 ASCII 大小写不敏感", () => {
    assert.deepEqual(matchMarkers("please complete Geetest verification"), ["geetest"]);
    assert.deepEqual(matchMarkers("操作过于频繁，请稍后再试"), ["频繁"]);
  });
});

describe("A-P0-PROBE shallowJsonEnvelope 深度限制", () => {
  it("只返回深度 ≤ 1 的标量字段，不进入嵌套对象", () => {
    const { entries } = shallowJsonEnvelope(
      JSON.stringify({ retcode: 0, message: "ok", data: { deep: "x" } }),
    );
    assert.deepEqual(entries.map(([k]) => k).sort(), ["message", "retcode"]);
  });

  it("非 JSON 文本返回 ok:false 而不抛异常", () => {
    const r = shallowJsonEnvelope("<html>not json</html>");
    assert.equal(r.ok, false);
    assert.deepEqual(r.entries, []);
  });
});

describe("A-P0-PROBE readBodyCapped 大小上限", () => {
  it("超过上限时截断并标记 truncated", async () => {
    const chunk = new Uint8Array(1024).fill(0x61);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const { buffer, truncated } = await readBodyCapped(stream, 1500);
    assert.equal(truncated, true);
    assert.equal(buffer.byteLength, 1500);
  });

  it("未超上限时完整读取", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });
    const { buffer, truncated } = await readBodyCapped(stream, 1024);
    assert.equal(truncated, false);
    assert.equal(new TextDecoder().decode(buffer), "hello");
  });

  it("空流返回空 buffer", async () => {
    const { buffer, truncated } = await readBodyCapped(null, 1024);
    assert.equal(buffer.byteLength, 0);
    assert.equal(truncated, false);
  });
});
