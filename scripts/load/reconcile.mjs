// A-P5-RELEASE: offline, strict aggregate-only input. No raw addresses, ids, URLs or API calls.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  AUTH_MAIL_POOLS,
  authTotalOccupancy,
  dayRemaining,
  floorIsEngaged,
  MAIL_AUTH_DAY,
  MAIL_AUTH_FLOOR,
  MAIL_BASE_DAY,
  MAIL_POOLS,
  MAIL_SIGNUP_AUTH_DAY,
  MAIL_URGENT_DAY,
  MAIL_URGENT_FLOOR,
  occupancyTotal,
  PLATFORM_MAIL_DAY_LIMIT,
  utcDayPeriod,
} from "../../packages/contracts/src/index.ts";

function keys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...expected].sort().join()
  )
    throw new Error("invalid aggregate shape");
}
function count(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid count");
  return n;
}
function amount(n) {
  if (!Number.isFinite(n) || n < 0) throw new Error("invalid measurement");
  return n;
}
function day(d) {
  if (
    typeof d !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
    !Number.isFinite(Date.parse(d)) ||
    utcDayPeriod(Date.parse(d)).key !== d
  )
    throw new Error("invalid UTC day");
  return d;
}
const meterNames = ["workers", "d1", "do", "queue"];
export function reconcile(input) {
  keys(input, ["synthetic", "days", "crossDayAccepts", "meters"]);
  if (
    typeof input.synthetic !== "boolean" ||
    !Array.isArray(input.days) ||
    input.days.length === 0 ||
    !Array.isArray(input.crossDayAccepts)
  )
    throw new Error("invalid input");
  keys(input.meters, meterNames);
  const dates = new Set(input.days.map((d) => day(d.day)));
  if (dates.size !== input.days.length) throw new Error("duplicate day");
  const flows = new Set();
  for (const flow of input.crossDayAccepts) {
    keys(flow, ["ledgerDay", "acceptedDay", "count"]);
    day(flow.ledgerDay);
    day(flow.acceptedDay);
    count(flow.count);
    const key = `${flow.ledgerDay}:${flow.acceptedDay}`;
    if (
      !dates.has(flow.ledgerDay) ||
      !dates.has(flow.acceptedDay) ||
      flow.ledgerDay === flow.acceptedDay ||
      flows.has(key)
    )
      throw new Error("invalid cross-day mapping");
    flows.add(key);
  }
  const days = input.days.map((row) => {
    keys(row, ["day", "pools", "acceptedKnown", "rejectedKnown", "platform"]);
    keys(row.pools, MAIL_POOLS);
    for (const p of MAIL_POOLS) {
      keys(row.pools[p], ["settled", "reserved", "uncertain"]);
      Object.values(row.pools[p]).forEach(count);
    }
    count(row.acceptedKnown);
    count(row.rejectedKnown);
    const auth = authTotalOccupancy(row.pools);
    const pools = [
      ["auth", auth, MAIL_AUTH_DAY, MAIL_AUTH_FLOOR],
      ["base", row.pools.base_business, MAIL_BASE_DAY, null],
      ["urgent", row.pools.urgent_business, MAIL_URGENT_DAY, MAIL_URGENT_FLOOR],
    ].map(([pool, used, limit, floor]) => ({
      pool,
      ...used,
      limit,
      remaining: dayRemaining(limit, used),
      overLimit: occupancyTotal(used) > limit,
      floorEngaged: floor === null ? null : floorIsEngaged(dayRemaining(limit, used), floor),
    }));
    const sum = (key) => pools.reduce((n, p) => n + p[key], 0);
    const unresolvedSettled = sum("settled") - row.acceptedKnown - row.rejectedKnown;
    if (unresolvedSettled < 0) throw new Error("terminal evidence exceeds settled ledger");
    const incoming = input.crossDayAccepts
      .filter((f) => f.acceptedDay === row.day)
      .reduce((n, f) => n + f.count, 0);
    const outgoing = input.crossDayAccepts
      .filter((f) => f.ledgerDay === row.day)
      .reduce((n, f) => n + f.count, 0);
    if (outgoing > row.acceptedKnown) throw new Error("cross-day evidence exceeds known accepts");
    const acceptedMinimum = row.acceptedKnown - outgoing + incoming;
    const acceptedMaximum = acceptedMinimum + sum("uncertain") + unresolvedSettled;
    let platform = null;
    if (row.platform !== null) {
      keys(row.platform, ["accountAccepted", "otherAccepted", "applicationAccepted", "dayLimit"]);
      for (const v of Object.values(row.platform)) if (v !== null) count(v);
      const p = row.platform;
      const attributed =
        p.accountAccepted !== null && p.otherAccepted !== null
          ? p.accountAccepted - p.otherAccepted
          : null;
      if (attributed !== null && attributed < 0)
        throw new Error("other usage exceeds account usage");
      platform = {
        ...p,
        attributed,
        attributionDelta:
          attributed === null || p.applicationAccepted === null
            ? null
            : attributed - p.applicationAccepted,
        knownAcceptedDelta:
          p.applicationAccepted === null ? null : p.applicationAccepted - acceptedMinimum,
        withinUncertainty:
          p.applicationAccepted === null
            ? null
            : p.applicationAccepted >= acceptedMinimum && p.applicationAccepted <= acceptedMaximum,
        accountRemaining:
          p.dayLimit === null || p.accountAccepted === null
            ? null
            : Math.max(0, p.dayLimit - p.accountAccepted),
        configuredDayLimit: PLATFORM_MAIL_DAY_LIMIT,
        limitChanged: p.dayLimit === null ? null : p.dayLimit !== PLATFORM_MAIL_DAY_LIMIT,
      };
    }
    const exact =
      platform !== null &&
      platform.attributionDelta === 0 &&
      platform.knownAcceptedDelta === 0 &&
      sum("uncertain") === 0 &&
      unresolvedSettled === 0;
    return {
      day: row.day,
      pools,
      signup: {
        ...row.pools[AUTH_MAIL_POOLS[1]],
        limit: MAIL_SIGNUP_AUTH_DAY,
        overLimit: occupancyTotal(row.pools.new_registration) > MAIL_SIGNUP_AUTH_DAY,
      },
      reserved: sum("reserved"),
      uncertain: sum("uncertain"),
      unresolvedSettled,
      rejectedKnown: row.rejectedKnown,
      incoming,
      outgoing,
      acceptedMinimum,
      acceptedMaximum,
      platform,
      comparison: platform === null ? "unknown" : exact ? "counts_match" : "needs_review",
    };
  });
  const meters = Object.fromEntries(
    meterNames.map((name) => {
      const m = input.meters[name];
      if (m === null) return [name, null];
      keys(m, ["from", "to", "metrics"]);
      if (
        !Number.isSafeInteger(m.from) ||
        !Number.isSafeInteger(m.to) ||
        m.to <= m.from ||
        !Array.isArray(m.metrics) ||
        m.metrics.length === 0
      )
        throw new Error("invalid meter window");
      const names = new Set();
      const metrics = m.metrics.map((metric) => {
        keys(metric, [
          "unit",
          "application",
          "other",
          "account",
          "included",
          "billedQuantity",
          "billedCost",
        ]);
        const units = {
          workers: ["requests", "cpu_ms"],
          d1: ["rows_read", "rows_written", "storage_bytes"],
          do: ["requests", "duration_gb_s", "rows_read", "rows_written", "storage_bytes"],
          queue: ["operations", "retry_operations", "dlq_messages"],
        };
        if (!units[name].includes(metric.unit) || names.has(metric.unit))
          throw new Error("invalid meter unit");
        names.add(metric.unit);
        for (const [k, v] of Object.entries(metric)) if (k !== "unit" && v !== null) amount(v);
        return {
          ...metric,
          attributionDelta: [metric.account, metric.application, metric.other].includes(null)
            ? null
            : metric.account - metric.application - metric.other,
          beyondIncluded:
            metric.account === null || metric.included === null
              ? null
              : Math.max(0, metric.account - metric.included),
        };
      });
      return [name, { ...m, metrics }];
    }),
  );
  return {
    schema: 1,
    synthetic: input.synthetic,
    evidence: input.synthetic ? "E1_synthetic" : "owner_supplied_unverified",
    days,
    meters,
    finalRelease: "not_decided",
    notes: [
      "settled includes accepted AND explicit rejections; reserved is not sent",
      "unknown remains occupied; no automatic retry or refund",
      "counts_match is not delivery or billing approval",
      "meter windows and units are independent; no local CPU conversion or assumed pricing",
    ],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("one aggregate input required");
    console.log(
      JSON.stringify(reconcile(JSON.parse(await readFile(process.argv[2], "utf8"))), null, 2),
    );
  } catch {
    console.error("A-P5-RELEASE 对账输入无效；请检查脱敏聚合 schema。未输出输入或原始错误。");
    process.exitCode = 1;
  }
}
