import { ADMIN_AUDIT_TTL, MATCH_PAGE } from "@hoyo/contracts";

export interface AdminAudit {
  readonly actorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string;
  readonly createdAt: number;
  /** 可选的对象引用（如采用的 AI 草稿 profile）；不放正文、凭证或请求内容。 */
  readonly detailRef?: string;
}

/** 只存动作及对象引用；不记录请求、Cookie、凭证或 Access 邮箱。 */
export function auditStatement(db: D1Database, audit: AdminAudit): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_log
    (id, actor_type, actor_id, action, target_type, target_id, reason, detail_ref, created_at, expires_at)
    VALUES (?, 'admin', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      audit.actorId,
      audit.action,
      audit.targetType,
      audit.targetId,
      audit.reason,
      audit.detailRef ?? null,
      audit.createdAt,
      audit.createdAt + ADMIN_AUDIT_TTL * 1_000,
    );
}

/** 按管理员部分索引筛选到期记录，每次最多删除 MATCH_PAGE 行，保留系统行。 */
export async function cleanupAdminAuditPage(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(`DELETE FROM audit_log WHERE actor_type = 'admin' AND id IN (
    SELECT id FROM audit_log INDEXED BY idx_audit_log_admin_expiry
    WHERE expires_at <= ? AND actor_type = 'admin' ORDER BY expires_at, id LIMIT ?
  )`)
    .bind(now, MATCH_PAGE)
    .run();
}

/** 将同一审计写入作为条件提交效果；不让审计先于业务落库。 */
export function auditEffect(
  audit: AdminAudit,
  id = crypto.randomUUID(),
): import("../storage/cas").GuardedEffect {
  return {
    kind: "insert",
    table: "audit_log",
    columns: [
      "id",
      "actor_type",
      "actor_id",
      "action",
      "target_type",
      "target_id",
      "reason",
      "detail_ref",
      "created_at",
      "expires_at",
    ],
    rows: [
      [
        id,
        "admin",
        audit.actorId,
        audit.action,
        audit.targetType,
        audit.targetId,
        audit.reason,
        audit.detailRef ?? null,
        audit.createdAt,
        audit.createdAt + ADMIN_AUDIT_TTL * 1_000,
      ],
    ],
  };
}
