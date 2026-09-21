// P0-01 探针：sources-reachability 的探测核心（纯逻辑，Node runner 与 Worker 打包共同使用）。
// 只读约束见 lib/guard-core.mjs 文件头；本文件只做"单来源一次受限 GET + 派生证据条目"。
// 证据条目刻意不保存完整响应正文，只保存大小、hash、顶层信封标量与结构键名。

import {
  analyzeRestrictionSignals,
  guardedFetch,
  sha256Hex,
  shallowJsonEnvelope,
} from "../lib/guard-core.mjs";

/**
 * @param {{ id: string, label: string, url: string, host: string, contract_ref: string, verification_state: string }} source
 * @returns {Promise<Record<string, unknown>>}
 */
export async function probeSource(source) {
  const obs = await guardedFetch(source.url, { allowedHosts: [source.host] });

  const entry = {
    id: source.id,
    label: source.label,
    url: source.url,
    host: source.host,
    lead: { verification_state: source.verification_state, contract_ref: source.contract_ref },
    elapsed_ms: obs.elapsed_ms,
    error: obs.error,
    http: obs.http
      ? {
          status: obs.http.status,
          status_text: obs.http.status_text,
          redirect_status: obs.http.redirect_status,
          followed_redirect: obs.http.followed_redirect,
          headers: obs.http.headers,
        }
      : null,
    body: null,
    restriction: null,
    outcome: null,
  };

  if (obs.error) {
    entry.outcome = obs.error.kind === "guard" ? "guard_error" : "network_error";
    return entry;
  }

  const bodyText = obs.body.text;
  const contentType = obs.http.headers.content_type;
  const restriction = analyzeRestrictionSignals({
    status: obs.http.status,
    headers: obs.http.headers,
    bodyText,
    contentType,
  });
  const envelope = shallowJsonEnvelope(bodyText);
  let topLevelKeys = null;
  if (envelope.ok) {
    try {
      topLevelKeys = Object.keys(JSON.parse(bodyText === "" ? "{}" : bodyText));
    } catch {
      topLevelKeys = null;
    }
  }

  entry.body = {
    bytes_read: obs.body.bytes_read,
    truncated: obs.body.truncated,
    sha256: await sha256Hex(bodyText),
    json_parse_ok: envelope.ok,
    json_top_level_keys: topLevelKeys,
    json_envelope_scalars: Object.fromEntries(envelope.entries),
  };
  entry.restriction = restriction;
  entry.outcome = restriction.restricted
    ? "restriction_signal"
    : obs.http.status >= 200 && obs.http.status < 400
      ? "reached"
      : "http_error_status";
  return entry;
}

/**
 * @param {Array<Parameters<typeof probeSource>[0]>} sources
 */
export async function probeSources(sources) {
  const entries = [];
  for (const source of sources) {
    entries.push(await probeSource(source));
  }
  return {
    sources: entries,
    summary: {
      total: entries.length,
      reached: entries.filter((r) => r.outcome === "reached").length,
      restriction_signal: entries.filter((r) => r.outcome === "restriction_signal").length,
      http_error_status: entries.filter((r) => r.outcome === "http_error_status").length,
      network_error: entries.filter((r) => r.outcome === "network_error").length,
      guard_error: entries.filter((r) => r.outcome === "guard_error").length,
    },
  };
}
