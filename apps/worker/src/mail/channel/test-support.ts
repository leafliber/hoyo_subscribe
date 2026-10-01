import { env } from "cloudflare:test";
import { SESSION_IDLE_TTL, SUBSCRIPTION_SCHEMA_VERSION, utcDayPeriod } from "@hoyo/contracts";
import { makePendingSession } from "../../auth/consume/session";
import { hashRecoverySecret } from "../../auth/recovery/credential";
import { testKeyring } from "../../shell/test-support";
import { encryptField } from "../../storage/crypto/aead";
import { computeEmailKey } from "../../storage/crypto/mac";
import { splitSqlStatements } from "../../storage/split-sql";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: boolean },
    ): Record<string, string>;
  }
}
const migrations = import.meta.glob("../../../../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SECOND = 1_000;
export const now = utcDayPeriod(1_900_000_000_000).startMs + SECOND;
let sequence = 0;
const keysPromise = testKeyring;
async function resetDatabase(): Promise<void> {
  const objects =
    (
      await env.DB.prepare(`SELECT type,name FROM sqlite_master
    WHERE type IN ('trigger','view') AND name NOT LIKE 'sqlite_%'`).all<{
        type: string;
        name: string;
      }>()
    ).results ?? [];
  for (const obj of objects)
    await env.DB.exec(`DROP ${obj.type.toUpperCase()} IF EXISTS "${obj.name}";`);
  for (let pass = 0; pass < 20; pass++) {
    const tables =
      (
        await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND substr(name,1,3) <> '_cf'`).all<{ name: string }>()
      ).results ?? [];
    if (tables.length === 0) break;
    for (const table of tables) {
      try {
        await env.DB.exec(`DROP TABLE IF EXISTS "${table.name}";`);
      } catch {
        /* dependency */
      }
    }
  }
}

export async function migrate() {
  await resetDatabase();
  for (const name of Object.keys(migrations).sort()) {
    await env.DB.batch(
      splitSqlStatements(migrations[name] ?? "").map((sql) => env.DB.prepare(sql)),
    );
  }
}

export async function first<T>(sql: string, ...args: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...args)
    .first<T>();
}

export async function seed(): Promise<{
  userId: string;
  session: { userId: string; sessionId: string; sessionTokenHash: string };
  token: string;
  recoveryId: string;
  recoverySecret: string;
  email: string;
}> {
  const keys = await keysPromise;
  const userId = crypto.randomUUID();
  const email = `Case${++sequence}@example.test`;
  const emailKey = await computeEmailKey(keys.emailLookup(), email.toLowerCase());
  const ciphertext = await encryptField(
    keys.fieldEncryption(),
    { type: "delivery-email-address", id: userId },
    email,
  );
  await env.DB.prepare(`INSERT INTO users
    (id,"order",status,email_key,email_binding_id,email_ciphertext,email_version,
      auth_epoch,recovery_epoch,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,0,0,?,?)`)
    .bind(userId, sequence, "active", emailKey, crypto.randomUUID(), ciphertext, now, now)
    .run();
  await env.DB.prepare(`INSERT INTO user_subscriptions
    (user_id,state,schema_version,revision,scope_json,calendar_json,notifications_json,created_at,updated_at)
    VALUES (?,'uninitialized',${SUBSCRIPTION_SCHEMA_VERSION},0,NULL,NULL,NULL,?,?)`)
    .bind(userId, now, now)
    .run();
  const made = await makePendingSession(now);
  await env.DB.prepare(`INSERT INTO sessions
    (id,user_id,token_hash,state,label,platform_hint,issued_at,absolute_expires_at,
      expires_at,renewed_at,auth_epoch,recovery_epoch,recovery_code_required,activated_at,
      created_at,updated_at)
    VALUES (?,?,?,'active',?,?,?,?,?,?,?,?,0,?,?,?)`)
    .bind(
      made.id,
      userId,
      made.tokenHash,
      made.label,
      made.platformHint,
      now,
      made.absoluteExpiresAt,
      Math.min(now + SESSION_IDLE_TTL * SECOND, made.absoluteExpiresAt),
      now,
      0,
      0,
      now,
      now,
      now,
    )
    .run();
  const recoveryId = crypto.randomUUID();
  const recoverySecret = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO recovery_credentials
    (id,user_id,secret_hash,generation,saved_confirmed_at,created_at,updated_at)
    VALUES (?,?,?,1,?,?,?)`)
    .bind(recoveryId, userId, await hashRecoverySecret(recoverySecret), now, now, now)
    .run();
  return {
    userId,
    session: { userId, sessionId: made.id, sessionTokenHash: made.tokenHash },
    token: made.cookieValue,
    recoveryId,
    recoverySecret,
    email,
  };
}

export async function run(sql: string, ...args: unknown[]) {
  return env.DB.prepare(sql)
    .bind(...args)
    .run();
}
export const selectedConfig = {
  schema_version: SUBSCRIPTION_SCHEMA_VERSION,
  scope: { games: ["genshin"], regions: ["CN"] },
  calendar: { event_types: ["limited_event"], node_types: [], alarms_enabled: false },
  notifications: {
    rule_ids: [],
    new_event: false,
    important_change: true,
    cancelled_or_retracted: true,
    late_discovery: true,
  },
};
