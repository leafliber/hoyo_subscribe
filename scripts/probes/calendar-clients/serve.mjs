#!/usr/bin/env node

// P0-04 · 日历客户端完整快照与 VALARM 实测台
// 零依赖。仅本机监听；不部署、不写业务库、不发任何邮件。
// 合同依据：主方案 §6.2 完整快照、§6.4 UID/SEQUENCE、§6.5 格式与守卫、§10.3 客户端条目、[R11]

import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const LOG = path.join(REPO, "docs/evidence/p0/calendar-poll-log.jsonl");
const PORT = Number(process.env.PORT || 8800);
const START = new Date();

// ---------- RFC 5545 基元 ----------
const pad = (n, w = 2) => String(n).padStart(w, "0");
const utc = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
  `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const dateOnly = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const plus = (ms) => new Date(START.getTime() + ms);
const MIN = 60_000,
  HOUR = 60 * MIN,
  DAY = 24 * HOUR;

const esc = (s) =>
  String(s).replace(/\\/g, "\\\\").replace(/;/g, ";").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// 按 75 octet 折行，且不得切断 UTF-8 多字节字符（§6.5「UTF-8 安全折行」）
function fold(line) {
  const buf = Buffer.from(line, "utf8");
  if (buf.length <= 75) return line;
  const out = [];
  let i = 0,
    limit = 75;
  while (i < buf.length) {
    let end = Math.min(i + limit, buf.length);
    if (end < buf.length) while (end > i && (buf[end] & 0xc0) === 0x80) end--; // 回退到字符边界
    out.push(buf.subarray(i, end).toString("utf8"));
    i = end;
    limit = 74; // 续行首个空格占 1 octet
  }
  return out.join("\r\n ");
}

const NS = "p0probe"; // 代表 feed_namespace（§6.4）
const DOMAIN = "calendar-probe.invalid"; // 固定日历命名空间

function vevent(e) {
  const L = [];
  L.push("BEGIN:VEVENT");
  L.push(`UID:${NS}-${e.uid}@${DOMAIN}`);
  L.push(`DTSTAMP:${utc(e.changedAt)}`);
  L.push(`LAST-MODIFIED:${utc(e.changedAt)}`);
  L.push(`SEQUENCE:${e.sequence}`);
  if (e.allDay) {
    L.push(`DTSTART;VALUE=DATE:${dateOnly(e.start)}`);
    L.push(`DTEND;VALUE=DATE:${dateOnly(new Date(e.start.getTime() + DAY))}`); // 非包含
  } else {
    L.push(`DTSTART:${utc(e.start)}`);
    L.push(`DTEND:${utc(new Date(e.start.getTime() + (e.durMs ?? HOUR)))}`); // 非包含
  }
  L.push(`SUMMARY:${esc(e.summary)}`);
  if (e.desc) L.push(`DESCRIPTION:${esc(e.desc)}`);
  L.push(`STATUS:${e.status || "CONFIRMED"}`);
  L.push("TRANSP:TRANSPARENT");
  if (e.alarmMin != null) {
    L.push("BEGIN:VALARM");
    L.push("ACTION:DISPLAY");
    L.push(`TRIGGER:-PT${e.alarmMin}M`);
    L.push(`DESCRIPTION:${esc(`提醒：${e.summary}`)}`);
    L.push("END:VALARM");
  }
  L.push("END:VEVENT");
  return L;
}

function buildIcs(events) {
  const L = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "PRODID:-//hoyo-subscribe//P0-04 client probe//ZH",
    "METHOD:PUBLISH",
  ];
  for (const e of events) L.push(...vevent(e));
  L.push("END:VCALENDAR");
  return `${L.map(fold).join("\r\n")}\r\n`;
}

// ---------- 事件定义（UID 跨步骤稳定；改期不换 ID，§3.3）----------
const base = {
  A: {
    uid: "ev-a-alarm",
    summary: "【A】带闹钟：维护开始",
    start: plus(25 * MIN),
    alarmMin: 15,
    sequence: 0,
    changedAt: START,
  },
  B: {
    uid: "ev-b-remove",
    summary: "【B】将被移除后重新加入",
    start: plus(3 * DAY),
    sequence: 0,
    changedAt: START,
  },
  C: {
    uid: "ev-c-date",
    summary: "【C】纯日期：具体时刻未公布",
    start: plus(5 * DAY),
    allDay: true,
    sequence: 0,
    changedAt: START,
  },
  D: {
    uid: "ev-d-fold",
    summary:
      "【D】超长中文标题折行测试 🎆 原神「花神诞祭」限时活动第二阶段解锁与奖励领取截止提醒 🌙 含 emoji 与全角标点，用于验证 UTF-8 安全折行",
    start: plus(2 * DAY),
    sequence: 0,
    changedAt: START,
  },
  E: {
    uid: "ev-e-move",
    summary: "【E】将被改期",
    start: plus(7 * DAY),
    sequence: 0,
    changedAt: START,
  },
  F: {
    uid: "ev-f-cancel",
    summary: "【F】将被取消",
    start: plus(10 * DAY),
    sequence: 0,
    changedAt: START,
  },
};
const clone = (e, patch = {}) => ({ ...e, ...patch });

const STEPS = [
  {
    n: 0,
    name: "基线快照",
    note: "6 条全在。先让客户端完整拉一次，再进入下一步。",
    build: () => [base.A, base.B, base.C, base.D, base.E, base.F],
  },
  {
    n: 1,
    name: "完整快照删除",
    note: "B 缺席。支持的客户端必须把 B 从这份订阅中移除（§6.2）。",
    build: () => [base.A, base.C, base.D, base.E, base.F],
  },
  {
    n: 2,
    name: "重新加入",
    note: "B 以同 UID、同 SEQUENCE 回来。相同内容重新进入集合不是新的官方修订（§6.4）。",
    build: () => [base.A, base.B, base.C, base.D, base.E, base.F],
  },
  {
    n: 3,
    name: "改期",
    note: "E 改到 +9 天，SEQUENCE 0→1，DTSTAMP 取实际变更时间。",
    build: (t) => [
      base.A,
      base.B,
      base.C,
      base.D,
      clone(base.E, {
        start: plus(9 * DAY),
        sequence: 1,
        changedAt: t,
        summary: "【E】已改期（新时间）",
      }),
      base.F,
    ],
  },
  {
    n: 4,
    name: "取消",
    note: "F 变 STATUS:CANCELLED，SEQUENCE 0→1，保留最近已发布时间，不虚构新日期（§6.3）。",
    build: (t, s3) => [
      base.A,
      base.B,
      base.C,
      base.D,
      s3,
      clone(base.F, { status: "CANCELLED", sequence: 1, changedAt: t, summary: "【F】官方已取消" }),
    ],
  },
  {
    n: 5,
    name: "503 守卫兜底",
    note: "服务端返回 503。客户端应保留上一次成功结果，不清空日历（§6.5）。",
    build: null,
  },
  {
    n: 6,
    name: "恢复 200",
    note: "内容同步骤 4。确认 503 期间客户端没有丢内容。",
    build: (_t, _s3, s4) => s4,
  },
];

let step = 0;
let rescheduledE = null,
  step4Events = null,
  body = "",
  etag = "";

function render() {
  const now = new Date();
  const s = STEPS[step];
  if (s.build === null) {
    body = "";
    etag = "";
    return;
  }
  if (step === 3 && !rescheduledE)
    rescheduledE = clone(base.E, {
      start: plus(9 * DAY),
      sequence: 1,
      changedAt: now,
      summary: "【E】已改期（新时间）",
    });
  const eRef = rescheduledE || base.E;
  let events;
  if (step === 4) {
    step4Events = s.build(now, eRef);
    events = step4Events;
  } else if (step === 6) {
    events = step4Events || [base.A, base.B, base.C, base.D, eRef, base.F];
  } else events = s.build(now, eRef);
  body = buildIcs(events);
  etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
}
render();

function log(rec) {
  try {
    fs.appendFileSync(LOG, `${JSON.stringify(rec)}\n`);
  } catch {
    /* 证据目录不存在时不影响测试 */
  }
  const t = rec.at.slice(11, 19);
  console.log(
    `  [${t}] ${rec.method} ${rec.status}  step=${rec.step}  ${rec.conditional ? "If-None-Match " : ""}${rec.ua.slice(0, 58)}`,
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const ua = req.headers["user-agent"] || "(none)";

  if (url.pathname === "/cal.ics") {
    const s = STEPS[step];
    const rec = {
      at: new Date().toISOString(),
      method: req.method,
      step,
      step_name: s.name,
      ua,
      conditional: Boolean(req.headers["if-none-match"]),
      if_none_match: req.headers["if-none-match"] || null,
      remote: req.socket.remoteAddress,
      status: 0,
    };
    if (s.build === null) {
      rec.status = 503;
      res.writeHead(503, {
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": "300",
        "Cache-Control": "private, no-store",
      });
      res.end("503 shrink-guard simulation\n");
      log(rec);
      return;
    }
    if (req.headers["if-none-match"] === etag) {
      rec.status = 304;
      res.writeHead(304, { ETag: etag, "Cache-Control": "private, no-store" });
      res.end();
      log(rec);
      return;
    }
    rec.status = 200;
    res.writeHead(200, {
      "Content-Type": "text/calendar; charset=utf-8",
      ETag: etag,
      "Cache-Control": "private, no-store",
      "Content-Disposition": 'inline; filename="cal.ics"',
    });
    res.end(req.method === "HEAD" ? undefined : body);
    log(rec);
    return;
  }

  const m = url.pathname.match(/^\/step\/(\d)$/);
  if (m) {
    setStep(Number(m[1]));
    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }

  const s = STEPS[step];
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>P0-04 实测台</title>
<style>body{font:15px/1.6 system-ui;max-width:760px;margin:40px auto;padding:0 16px}
code{background:#f3f3f3;padding:2px 5px;border-radius:4px}a{display:inline-block;margin:3px 6px 3px 0;padding:6px 12px;border:1px solid #ccc;border-radius:6px;text-decoration:none;color:#111}
.cur{background:#111;color:#fff;border-color:#111}</style>
<h1>P0-04 日历客户端实测台</h1>
<p>订阅地址：<code>http://&lt;本机或隧道地址&gt;:${PORT}/cal.ics</code></p>
<h2>当前：步骤 ${step} · ${s.name}</h2><p>${s.note}</p>
<p>${STEPS.map((x) => `<a class="${x.n === step ? "cur" : ""}" href="/step/${x.n}">${x.n} ${x.name}</a>`).join("")}</p>
<p>条目数：${s.build === null ? "—（503）" : (body.match(/BEGIN:VEVENT/g) || []).length}　ETag：<code>${etag || "—"}</code></p>
<p>请求日志：<code>docs/evidence/p0/calendar-poll-log.jsonl</code></p>`);
});

function setStep(n) {
  if (!Number.isInteger(n) || n < 0 || n >= STEPS.length) return;
  step = n;
  render();
  const s = STEPS[step];
  console.log(`\n=== 步骤 ${step} · ${s.name} ===\n${s.note}`);
  console.log(
    `条目数 ${s.build === null ? "—" : (body.match(/BEGIN:VEVENT/g) || []).length}　等待客户端拉取…\n`,
  );
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nP0-04 实测台 → http://127.0.0.1:${PORT}/`);
  console.log(`订阅地址      → http://127.0.0.1:${PORT}/cal.ics`);
  console.log(
    `Google Calendar 需要公网地址：另开终端跑  cloudflared tunnel --url http://127.0.0.1:${PORT}`,
  );
  console.log(`\n输入步骤号 0-${STEPS.length - 1} + 回车切换（也可点网页按钮）。Ctrl-C 结束。`);
  setStep(0);
});

readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const n = Number(l.trim());
  if (Number.isNaN(n)) console.log(`请输入 0-${STEPS.length - 1}`);
  else setStep(n);
});
