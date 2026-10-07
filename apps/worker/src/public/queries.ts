// P3-14：每条查询由索引定位当前代次/身份；不得退回旧代次，不读取身份表。
// 不直接调用 readCurrentPublicSnapshot：其整代 all() 无读量上界，本接口分片读取同一 current。
export const PUBLIC_HEAD_SQL = `SELECT id, generation, published_at FROM public_snapshots WHERE state = 'current'`;
export const PUBLIC_PAGE_SQL = `SELECT milestone_id,
  CASE WHEN length(CAST(node_json AS BLOB)) <= ? THEN node_json ELSE NULL END AS node_json
  FROM public_snapshot_nodes WHERE snapshot_id = ? AND milestone_id > ? ORDER BY milestone_id LIMIT ?`;
export const PUBLIC_DETAIL_SQL = `SELECT milestone_id,
  CASE WHEN length(CAST(node_json AS BLOB)) <= ? THEN node_json ELSE NULL END AS node_json
  FROM public_snapshot_nodes INDEXED BY idx_public_nodes_event
  WHERE snapshot_id = ? AND json_extract(node_json, '$.projection.event_id') = ? ORDER BY milestone_id LIMIT ?`;
// ADR-0028：排除"没有旧时间的改期"（种类由 contracts PUBLIC_UNANNOUNCED_PATCH_KIND 绑定），
// 与 isPublicChange 同一条件；放在 SQL 里，条数上限与截断标记只按真正公开的变更计算。
export const PUBLIC_CHANGES_SQL = `SELECT milestone_id,
  CASE WHEN length(CAST(node_json AS BLOB)) <= ? THEN node_json ELSE NULL END AS node_json
  FROM public_snapshot_nodes INDEXED BY idx_public_nodes_changes
  WHERE snapshot_id = ? AND json_extract(node_json, '$.game') = ?
    AND json_extract(node_json, '$.patch.retain_until') IS NOT NULL
    AND json_extract(node_json, '$.patch.retain_until') > ?
    AND (json_extract(node_json, '$.patch.kind') IS NOT ?
      OR json_extract(node_json, '$.patch.old_time') IS NOT NULL)
  ORDER BY json_extract(node_json, '$.patch.retain_until') DESC, milestone_id LIMIT ?`;
// 已下线来源（ADR-0016）的历史行留在库里（文章外键指向它），但不出现在公开状态。
export const PUBLIC_SOURCES_SQL = `SELECT source_id, last_success_at, verification_state FROM sources
  WHERE game = ? AND region = 'cn' AND source_id NOT IN (SELECT value FROM json_each(?))
  ORDER BY source_id LIMIT ?`;
// 扫描 pending 索引有限前缀；超过保护值降级为未知，禁止把截断计数当精确总量。
// 每个候选由第一条证据（其来源唯一）归属游戏；人工 run_id 可空，不能只依赖 extraction_runs。
export const PUBLIC_PENDING_SQL = `SELECT COALESCE((SELECT s.game FROM extraction_runs r
  JOIN article_versions av ON av.id = r.article_version_id
  JOIN articles a ON a.id = av.article_id JOIN sources s ON s.source_id = a.source_id WHERE r.id = c.run_id), (
  SELECT s.game FROM evidence e JOIN article_versions av ON av.id = e.article_version_id
  JOIN articles a ON a.id = av.article_id JOIN sources s ON s.source_id = a.source_id
  WHERE e.candidate_id = c.id ORDER BY e.rowid LIMIT 1
)) AS game FROM candidates c WHERE c.review_status = 'pending' ORDER BY c.created_at LIMIT ?`;
// 补官方发布时间与已批准证据片段；证据必须已发布、在本代发布之前，且匹配该公开投影。
// 无法证明绑定时返回 null；不读取正文块，候选载荷只在内部作逐字段核对，不进入公共响应。
// P3-22：同一绑定顺带给出文章版本 ID，原文接口只读这些版本（ID 本身不进公共响应）。
export const PUBLIC_NOTICE_SQL = `SELECT json_extract(j.value, '$.id') AS id, av.official_published_at, av.id AS article_version_id,
    CASE WHEN p.milestone_id IS NOT NULL AND length(CAST(c.proposal_json AS BLOB)) <= ? THEN c.proposal_json ELSE NULL END AS proposal_json
  FROM json_each(?) j
  LEFT JOIN evidence e ON e.id = (
    SELECT ev.id FROM evidence ev INDEXED BY idx_public_evidence_node_time
    WHERE ev.milestone_id = json_extract(j.value, '$.id') AND ev.created_at <= ?
    ORDER BY ev.created_at DESC, ev.id DESC LIMIT 1
  )
  LEFT JOIN evidence ee ON ee.id = (
    SELECT latest.id FROM evidence latest WHERE latest.event_id = json_extract(j.value, '$.eventId')
    ORDER BY latest.rowid DESC LIMIT 1
  ) AND ee.created_at <= ? AND ee.candidate_id IS NOT NULL
  LEFT JOIN calendar_projections p ON p.milestone_id = json_extract(j.value, '$.id')
    AND p.projection_json = json_extract(j.value, '$.projection')
  LEFT JOIN candidates c ON c.id = COALESCE(ee.candidate_id, e.candidate_id) AND c.review_status = 'approved'
  LEFT JOIN article_versions av ON av.id = COALESCE(ee.article_version_id, e.article_version_id) AND p.milestone_id IS NOT NULL AND c.id IS NOT NULL`;
// P3-22（ADR-0014）：按上面绑定出的版本 ID 读正文。按抓取时间新到旧累计正文字节，
// 超过公共响应上限的行返回 NULL 正文，调用方明确报不可用，不把截断的原文当完整结果。
export const PUBLIC_ARTICLES_SQL = `SELECT av.id, av.version_no, av.completeness, av.official_published_at, av.fetched_at,
    a.official_url,
    CASE WHEN SUM(length(CAST(av.body_blocks_json AS BLOB))) OVER (ORDER BY av.fetched_at DESC, av.id) <= ?
      THEN av.body_blocks_json ELSE NULL END AS body_blocks_json
  FROM json_each(?) j
  JOIN article_versions av ON av.id = j.value
  JOIN articles a ON a.id = av.article_id
  ORDER BY av.fetched_at DESC, av.id`;
