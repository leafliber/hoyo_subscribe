/** 本地既有功能用例显式开放新运行门；不设置原有注册/邮件开关。 */
export async function seedOperationalControls(db: D1Database): Promise<void> {
  await db.batch(
    ["outbound_enabled", "email_seats_open", "email_routine_enabled", "business_mail_enabled"].map(
      (key) =>
        db
          .prepare(
            "INSERT INTO system_state(key,value_json,updated_at) VALUES (?,'true',1) ON CONFLICT(key) DO UPDATE SET value_json='true'",
          )
          .bind(key),
    ),
  );
}
