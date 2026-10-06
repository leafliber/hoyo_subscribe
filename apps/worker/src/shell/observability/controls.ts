import {
  type ControlFacts,
  controlFact,
  OPERATIONAL_CONTROL_DEFAULTS,
  OPERATIONAL_CONTROLS,
  type OperationalControl,
} from "@hoyo/contracts";
import { SOURCE_REGISTRY } from "../../sources/registry";
import { ApiError } from "../errors";

export function controlKey(control: OperationalControl, source?: string): string {
  if (control !== "source_enabled") {
    if (source !== undefined) throw new ApiError("validation");
    return control;
  }
  if (!SOURCE_REGISTRY.some((entry) => entry.sourceId === source)) throw new ApiError("validation");
  return `source:${source}`;
}
export async function readControl(db: D1Database, control: OperationalControl, source?: string) {
  try {
    const row = await db
      .prepare("SELECT value_json,updated_at FROM system_state WHERE key=?")
      .bind(controlKey(control, source))
      .first<{ value_json: string; updated_at: number }>();
    return {
      value: row
        ? controlFact(JSON.parse(row.value_json))
        : (OPERATIONAL_CONTROL_DEFAULTS[control] ?? ("unknown" as const)),
      updated_at: row?.updated_at ?? 0,
    };
  } catch {
    return { value: "unknown" as const, updated_at: 0 };
  }
}
export async function readControls(db: D1Database): Promise<ControlFacts> {
  const names = OPERATIONAL_CONTROLS.filter((c) => c !== "source_enabled");
  try {
    const rows = (
      await db
        .prepare(
          "SELECT key,value_json FROM system_state WHERE key IN (SELECT value FROM json_each(?))",
        )
        .bind(JSON.stringify(names))
        .all<{ key: string; value_json: string }>()
    ).results;
    return Object.fromEntries(
      names.map((name) => {
        const row = rows.find((r) => r.key === name);
        try {
          return [
            name,
            row
              ? controlFact(JSON.parse(row.value_json))
              : (OPERATIONAL_CONTROL_DEFAULTS[name] ?? "unknown"),
          ];
        } catch {
          return [name, "unknown"];
        }
      }),
    );
  } catch {
    return Object.fromEntries(names.map((name) => [name, "unknown"]));
  }
}
export async function controlsAllow(
  db: D1Database,
  ...controls: OperationalControl[]
): Promise<boolean> {
  const facts = await Promise.all(controls.map((c) => readControl(db, c)));
  return facts.every((f) => f.value === true);
}
export async function requireControl(db: D1Database, control: OperationalControl): Promise<void> {
  if (!(await controlsAllow(db, control))) throw new ApiError("temporarily_unavailable");
}

/** 控制键经过闭合类型/运行时校验；用于业务最终条件提交，避免先读后变更竞态。 */
export function controlPredicate(control: OperationalControl): string {
  if (!OPERATIONAL_CONTROLS.includes(control) || control === "source_enabled")
    throw new Error("invalid_control_predicate");
  return `EXISTS(SELECT 1 FROM system_state WHERE key='${control}' AND value_json='true')`;
}
export const WRITABLE_PREDICATE =
  "NOT EXISTS(SELECT 1 FROM system_state WHERE key='read_only' AND value_json='true')";
