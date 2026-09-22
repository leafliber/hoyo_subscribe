-- P1-04 · 数据组 3/14：公共日历（主方案 §8.1 第 3 组、§3.6、§6.3、§6.5）
-- 不存私人筛选移除；公共模板不含最终个人 UID（§8.1 第 3 组约束）。
-- 私人撤销池 / feed_retirements / 筛选差集暂存一律不建（AGENTS.md 禁止清单）。

-- 节点当前公共投影（发布路径写入；完整快照的历史代次在 public_snapshots）。
CREATE TABLE calendar_projections (
  milestone_id          TEXT PRIMARY KEY REFERENCES milestones (id),
  event_id              TEXT NOT NULL REFERENCES events (id),
  public_ical_revision  INTEGER NOT NULL,   -- 节点公共版本（权威计数在 milestones 同名列）
  projection_json       TEXT NOT NULL CHECK (json_valid(projection_json)),
  updated_at            INTEGER NOT NULL
);

CREATE INDEX idx_calendar_projections_event ON calendar_projections (event_id);

-- 共享更正层：按 Milestone 保存当前需要补偿的投影，不按用户复制（§6.3）。
-- 保留期：retain_until = max(最后更正时间 + CAL_PATCH_MIN_DAYS, 旧节点最晚时间 + CAL_PATCH_TAIL_DAYS)。
-- 历史行不删（连续改期累计旧时间保留水位，§6.3），由 retain_until 驱动清理。
CREATE TABLE calendar_patches (
  id                TEXT PRIMARY KEY,
  milestone_id      TEXT NOT NULL REFERENCES milestones (id),
  patch_kind        TEXT NOT NULL,          -- 改期/取消/撤回/恢复/分类纠正（§6.3 表格）；取值属 P3-05
  old_time_exact_ms INTEGER,
  old_time_date     TEXT,
  new_time_exact_ms INTEGER,
  new_time_date     TEXT,
  fact_reason       TEXT NOT NULL,          -- 分别说明事实原因，不虚构新日期（§6.3）
  effective_at      INTEGER NOT NULL,
  retain_until      INTEGER NOT NULL,
  superseded_at     INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- 同一 Milestone 至多一条未取代更正（§6.3：同一 Feed 同一 UID 最多一条）。
CREATE UNIQUE INDEX idx_calendar_patches_active
  ON calendar_patches (milestone_id) WHERE superseded_at IS NULL;
CREATE INDEX idx_calendar_patches_retention ON calendar_patches (retain_until);
CREATE INDEX idx_calendar_patches_milestone ON calendar_patches (milestone_id);

-- 公共快照代次：完整快照先构建后切换可见代次，禁止跨代拼接（§3.6、§6.5）。
-- state 取值（building/current/superseded）属 P3-05 状态机，不在本迁移枚举。
CREATE TABLE public_snapshots (
  id           TEXT PRIMARY KEY,
  generation   INTEGER NOT NULL UNIQUE,     -- 完整代次
  state        TEXT NOT NULL,
  built_at     INTEGER,
  published_at INTEGER,
  created_at   INTEGER NOT NULL
);

-- 任意时刻至多一个 current 代次：切换可见性必须先构建新代次（§3.6）。
CREATE UNIQUE INDEX idx_public_snapshots_single_current
  ON public_snapshots (state) WHERE state = 'current';

-- 快照节点集：整代表示，禁止跨代拼接（§3.6）。
CREATE TABLE public_snapshot_nodes (
  snapshot_id   TEXT NOT NULL REFERENCES public_snapshots (id),
  milestone_id  TEXT NOT NULL REFERENCES milestones (id),
  node_json     TEXT NOT NULL CHECK (json_valid(node_json)),
  PRIMARY KEY (snapshot_id, milestone_id)
);

CREATE INDEX idx_public_snapshot_nodes_milestone ON public_snapshot_nodes (milestone_id);
