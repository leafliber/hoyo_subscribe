import { ExactTimeValueSchema, TimeValueSchema } from "@hoyo/contracts";
import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { foldLine, type IcalEvent, serializeCalendar } from "./ical";

const event: IcalEvent = {
  uid: "synthetic-node@hoyo-calendar",
  sequence: 3,
  modifiedAt: Date.parse("2026-09-29T12:00:00Z"),
  time: TimeValueSchema.parse({
    precision: "date",
    date: "2026-10-01",
    source_timezone: "UTC+8",
    raw_expression: "10月1日",
    time_basis: "official_explicit",
  }) as IcalEvent["time"],
  summary: "合成日程😀；".repeat(30),
  description: "逗号,分号;反斜线\\与\r\n换行",
  url: null,
  cancelled: false,
  alarmSeconds: [],
};
describe("A-P3-ICS RFC 5545 格式", () => {
  it("中文与 emoji 在 75 octets 内折行，CRLF、文本转义、TRANSPARENT、纯日期非包含结束", () => {
    const body = serializeCalendar([event]);
    expect(body.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    for (const line of body.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    const unfolded = body.replaceAll("\r\n ", "");
    expect(unfolded).toContain(`SUMMARY:${event.summary}`);
    expect(unfolded).toContain("DESCRIPTION:逗号\\,分号\\;反斜线\\\\与\\n换行");
    expect(unfolded).toContain("DTSTART;VALUE=DATE:20261001\r\n");
    expect(unfolded).toContain("TRANSP:TRANSPARENT");
    expect(unfolded).not.toContain("DTEND");
    expect(unfolded).not.toContain("METHOD:CANCEL");
    expect(foldLine("😀".repeat(50)).replaceAll("\r\n ", "")).toBe("😀".repeat(50));
  });
  it("UTC Z、稳定变更时间、DISPLAY VALARM，取消只是单节点状态", () => {
    const time = TimeValueSchema.parse({
      precision: "datetime",
      utc_ms: Date.parse("2026-10-01T12:00:00Z"),
      source_timezone: "UTC",
      raw_expression: "明确",
      time_basis: "official_explicit",
    }) as IcalEvent["time"];
    const body = serializeCalendar([
      { ...event, time, alarmSeconds: [3600] },
      { ...event, uid: "cancelled@hoyo-calendar", cancelled: true },
    ]);
    expect(body).toContain("DTSTART:20261001T120000Z");
    expect(body).toContain("DTSTAMP:20260929T120000Z");
    expect(body).toContain("ACTION:DISPLAY\r\nTRIGGER:-PT3600S");
    expect(body).toContain("STATUS:CANCELLED");
    expect(body).not.toContain("DTEND");
  });
  it("ical.js 独立解析中文折行、DATE 隐含非包含结束、UTC 与 DISPLAY VALARM", () => {
    const timed: IcalEvent = {
      ...event,
      uid: "synthetic-timed@hoyo-calendar",
      time: ExactTimeValueSchema.parse({
        precision: "datetime",
        utc_ms: Date.parse("2026-10-01T12:00:00Z"),
        source_timezone: "UTC",
        raw_expression: "明确",
        time_basis: "official_explicit",
      }),
      alarmSeconds: [3600],
    };
    const parsed = new ICAL.Component(ICAL.parse(serializeCalendar([event, timed])));
    expect(parsed.name).toBe("vcalendar");
    expect(parsed.getFirstPropertyValue("version")).toBe("2.0");
    expect(parsed.getFirstPropertyValue("method")).toBeNull();
    const components = parsed.getAllSubcomponents("vevent");
    expect(components).toHaveLength(2);
    const date = new ICAL.Event(components[0]);
    expect(date.uid).toBe(event.uid);
    expect(date.summary).toBe(event.summary);
    expect(date.description).toBe(event.description.replaceAll("\r\n", "\n"));
    expect(date.sequence).toBe(event.sequence);
    expect(date.startDate.isDate).toBe(true);
    expect(date.startDate.toString()).toBe("2026-10-01");
    expect(date.endDate.toString()).toBe("2026-10-02");
    const exact = new ICAL.Event(components[1]);
    expect(exact.startDate.toString()).toBe("2026-10-01T12:00:00Z");
    expect(exact.endDate.toString()).toBe(exact.startDate.toString());
    const alarm = components[1]?.getFirstSubcomponent("valarm");
    expect(alarm?.getFirstPropertyValue("action")).toBe("DISPLAY");
    const trigger = alarm?.getFirstPropertyValue("trigger");
    if (!(trigger instanceof ICAL.Duration)) throw new Error("缺少合法 VALARM trigger");
    expect(trigger.toSeconds()).toBe(-3600);
    expect(components.every((component) => !component.hasProperty("dtend"))).toBe(true);
    expect(
      components.every((component) => component.getFirstPropertyValue("transp") === "TRANSPARENT"),
    ).toBe(true);
  });
  it("SEQUENCE 接近协议上限失败关闭，不回绕；拒绝 URL 行注入", () => {
    for (const sequence of [-1, 2 ** 31 - 1, 2 ** 31, 1.5])
      expect(() => serializeCalendar([{ ...event, sequence }])).toThrow();
    expect(() =>
      serializeCalendar([{ ...event, url: "https://example.invalid/\r\nATTACH:bad" }]),
    ).toThrow();
  });
});
