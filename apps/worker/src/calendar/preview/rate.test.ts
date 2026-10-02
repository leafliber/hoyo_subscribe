import {
  CALENDAR_PREVIEW_RATE_LIMIT,
  CALENDAR_PREVIEW_RATE_WINDOW,
  RATE_WINDOWS_MAX,
} from "@hoyo/contracts";
import { expect, it } from "vitest";
import { CalendarPreviewRateGate } from "./rate";

const T = Date.parse("2026-10-02T12:00:00Z");
const windowMs = CALENDAR_PREVIEW_RATE_WINDOW * 1000;

it("A-P3-PREVIEW 滑动窗口逐次到期，不在跨桶时双倍放行；isolate 重启可重置", () => {
  const rate = new CalendarPreviewRateGate();
  expect(rate.take("synthetic-session", T)).toBe(0);
  for (let i = 1; i < CALENDAR_PREVIEW_RATE_LIMIT; i++)
    expect(rate.take("synthetic-session", T + 1)).toBe(0);
  expect(rate.take("synthetic-session", T + windowMs - 1)).toBe(1);
  expect(rate.take("synthetic-session", T + windowMs)).toBe(0);
  expect(rate.take("synthetic-session", T + windowMs)).toBe(1);
  expect(rate.take("synthetic-session", T + windowMs + 1)).toBe(0);
  expect(new CalendarPreviewRateGate().take("synthetic-session", T)).toBe(0);
});

it("A-P3-PREVIEW 簿记满额不驱逐有效会话，过期后回收并允许新会话", () => {
  const rate = new CalendarPreviewRateGate();
  for (let i = 0; i < RATE_WINDOWS_MAX; i++) expect(rate.take(`synthetic-${i}`, T)).toBe(0);
  expect(rate.take("synthetic-overflow", T)).toBe(windowMs);
  for (let i = 1; i < CALENDAR_PREVIEW_RATE_LIMIT; i++) expect(rate.take("synthetic-0", T)).toBe(0);
  expect(rate.take("synthetic-0", T)).toBe(windowMs);
  expect(rate.take("synthetic-overflow", T + windowMs)).toBe(0);
});
