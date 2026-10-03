import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAIL_AUTH_DAY,
  MAIL_AUTH_FLOOR,
  MAIL_POOLS,
  MAIL_URGENT_DAY,
  MAIL_URGENT_FLOOR,
} from "../../packages/contracts/src/index.ts";
import { reconcile } from "./reconcile.mjs";

const makeDay = (day) => ({
  day,
  pools: Object.fromEntries(MAIL_POOLS.map((p) => [p, { settled: 0, reserved: 0, uncertain: 0 }])),
  acceptedKnown: 0,
  rejectedKnown: 0,
  platform: null,
});
export function sample() {
  return {
    synthetic: true,
    days: [makeDay("2026-10-03"), makeDay("2026-10-04")],
    crossDayAccepts: [],
    meters: { workers: null, d1: null, do: null, queue: null },
  };
}
test("A-P5-RELEASE 三日池合并认证子额，floor 包含不确定与预留", () => {
  const x = sample();
  x.days[0].pools.existing_auth.reserved = MAIL_AUTH_DAY - MAIL_AUTH_FLOOR;
  x.days[0].pools.urgent_business.uncertain = MAIL_URGENT_DAY - MAIL_URGENT_FLOOR;
  const r = reconcile(x);
  assert.equal(r.days[0].pools.length, 3);
  assert.equal(r.days[0].pools[0].floorEngaged, true);
  assert.equal(r.days[0].pools[2].floorEngaged, true);
  assert.equal(r.days[0].comparison, "unknown");
  assert.equal(r.days[1].pools[0].remaining, MAIL_AUTH_DAY);
  assert.equal(r.meters.workers, null);
});
test("A-P5-RELEASE 拒绝也已结算，跨日按接受日，其他应用独立归因", () => {
  const x = sample();
  x.days[0].pools.existing_auth = { settled: 5, reserved: 2, uncertain: 1 };
  x.days[0].acceptedKnown = 3;
  x.days[0].rejectedKnown = 2;
  x.crossDayAccepts = [{ ledgerDay: x.days[0].day, acceptedDay: x.days[1].day, count: 2 }];
  x.days[0].platform = {
    accountAccepted: 5,
    otherAccepted: 3,
    applicationAccepted: 2,
    dayLimit: null,
  };
  x.days[1].platform = {
    accountAccepted: 6,
    otherAccepted: 4,
    applicationAccepted: 2,
    dayLimit: null,
  };
  const r = reconcile(x);
  assert.equal(r.days[0].acceptedMinimum, 1);
  assert.equal(r.days[0].acceptedMaximum, 2);
  assert.equal(r.days[0].reserved, 2);
  assert.equal(r.days[0].comparison, "needs_review");
  assert.equal(r.days[1].comparison, "counts_match");
  assert.equal(r.finalRelease, "not_decided");
});
test("A-P5-RELEASE 平台缺事实保持 null，账户差异不可伪称匹配", () => {
  const x = sample();
  x.days[0].platform = {
    accountAccepted: 7,
    otherAccepted: 0,
    applicationAccepted: 0,
    dayLimit: null,
  };
  x.meters.workers = {
    from: 1,
    to: 2,
    metrics: [
      {
        unit: "cpu_ms",
        application: null,
        other: 2,
        account: 10,
        included: null,
        billedQuantity: null,
        billedCost: null,
      },
    ],
  };
  const r = reconcile(x);
  assert.equal(r.days[0].comparison, "needs_review");
  assert.equal(r.days[0].platform.attributionDelta, 7);
  assert.equal(r.meters.workers.metrics[0].attributionDelta, null);
  assert.equal(r.meters.workers.metrics[0].beyondIncluded, null);
});
test("A-P5-RELEASE 输入拒绝重复/伪 UTC 日期/负数/遗漏池/未知字段/重复跨日", () => {
  for (const mutate of [
    (x) => x.days.push(x.days[0]),
    (x) => (x.days[0].day = "2026-02-30"),
    (x) => (x.days[0].pools.existing_auth.settled = -1),
    (x) => delete x.days[0].pools.new_registration,
    (x) => (x.email = "secret"),
    (x) => (x.days[0].acceptedKnown = 1),
    (x) => (x.meters.workers = { from: 2, to: 1, metrics: [] }),
  ]) {
    const x = sample();
    mutate(x);
    assert.throws(() => reconcile(x));
  }
});
test("A-P5-RELEASE 超限不被 remaining=0 隐藏；不自动审批成本", () => {
  const x = sample();
  x.days[0].pools.existing_auth.uncertain = MAIL_AUTH_DAY + 1;
  const r = reconcile(x);
  assert.equal(r.days[0].pools[0].overLimit, true);
  assert.equal(r.finalRelease, "not_decided");
});

test("A-P5-RELEASE 跨日映射必须唯一且两日都在输入中，不能将占用重复归因", () => {
  const x = sample();
  x.days[0].acceptedKnown = 2;
  x.days[0].pools.existing_auth.settled = 2;
  const flow = { ledgerDay: x.days[0].day, acceptedDay: x.days[1].day, count: 1 };
  x.crossDayAccepts = [flow, flow];
  assert.throws(() => reconcile(x));
  x.crossDayAccepts = [{ ...flow, acceptedDay: "2026-10-05" }];
  assert.throws(() => reconcile(x));
  x.crossDayAccepts = [{ ...flow, count: 3 }];
  assert.throws(() => reconcile(x));
});
test("A-P5-RELEASE 各平台计量分开，实际超包含量及账户归因差异显式输出", () => {
  const x = sample();
  x.meters.d1 = {
    from: 1,
    to: 2,
    metrics: [
      {
        unit: "rows_read",
        application: 40,
        other: 50,
        account: 100,
        included: 80,
        billedQuantity: 20,
        billedCost: 1,
      },
    ],
  };
  const metric = reconcile(x).meters.d1.metrics[0];
  assert.equal(metric.attributionDelta, 10);
  assert.equal(metric.beyondIncluded, 20);
  assert.equal(metric.billedCost, 1);
});
