-- P3-14：只加读索引，不新增业务状态或保留副本。与 P3-06 撞号时后合入者改号。
CREATE INDEX idx_public_nodes_event ON public_snapshot_nodes
  (snapshot_id, json_extract(node_json, '$.projection.event_id'), milestone_id);
CREATE INDEX idx_public_nodes_changes ON public_snapshot_nodes
  (snapshot_id, json_extract(node_json, '$.game'), json_extract(node_json, '$.patch.retain_until') DESC, milestone_id)
  WHERE json_extract(node_json, '$.patch.retain_until') IS NOT NULL;
CREATE INDEX idx_public_evidence_node_time ON evidence (milestone_id, created_at DESC, id DESC);
CREATE INDEX idx_public_sources_scope ON sources (game, region, source_id);
