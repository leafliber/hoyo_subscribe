# P5-02 生命周期维护

仅后台 API，不扩管理页面。需要既有管理员会话及该会话绑定的 CSRF。

- `GET /api/v2/admin/reclaim?after=<order>`：按 MATCH_PAGE 返回待复核账号、真实活动水位、宽限终点、席位版本，以及暂停事实/更新时间。响应 no-store，不含邮箱或私人凭证。
- `POST /api/v2/admin/reclaim/confirm/<account-id>`：请求体为 `activity_at`、`grace_until`、`channel_revision`、`kind`（account/seat）与非空 `reason`。清单中的具体水位和版本必须仍然相同；账号须已走完宽限，席位须连同账号进入沉睡。确认即条件执行并审计，没有后台全局自动授权。
- `POST /api/v2/admin/reclaim/resume`：维护者核实并补齐丢失活动后，提交清单的 `expected_updated_at`、`last_success_at` 和理由。持久暂停记录缺失时版本为零。水位须新鲜，版本变化拒绝；不打开账号或席位的独立开关。该 isolate 仍有未能持久化的写失败时，readReclaimGate 继续失败关闭。

宽限不改变 active 状态，原账号证明、Feed 和交互可继续使用。新活动使旧确认失效并在下一扫描清除旧宽限。所有破坏提交再检查持久暂停、水位及独立开关；删除仍开启席位的账号同时需要席位开关。

后台分页调用既有 renewEmailSeat，不把发信、投递、退订页 GET 当活动。确认释放成功后才计 seat_released；退订和失败不计。账号先原子 deleting 并调用 calendarLifecycle/emailLifecycleHook，再复用既有分页清理，完成才释放账号存量。日计数和已结算预算不退款。

## 维护边界

scheduled 中先完成既有反馈维护，再使用 D1 平台查询限额的剩余量执行回收，同时遵守 RECLAIM_QUERY_BUDGET 和 EXECUTOR_BATCH_WALL_LIMIT。预算不足一个完整最坏页时不开始。账号与批次扫描、维护阶段的游标持久保存；每个单元出错本轮不重试，其他单元继续。最后一条游标提交提前留额；中断页可以幂等重放。预算值只在 contracts 注册表定义，平台 queryLimit 复用其已登记事实。

系统审计历史按部分索引逐页校正 `created_at + SYSTEM_AUDIT_TTL`，游标和校正在同一事务。整轮历史完成才删到期 system 行；管理员行由原管理审计清理负责。TTL 配置变化会重开校正轮次。

注册预占、验证码/回执和 pending Session 沿用已有 scheduled 清理原语；本卡补正式会话、过期证明/轮换、通道关闭后的同意、无引用文章/版本、Push 租期与宽限、Delivery 和邮件元数据、调度批次及系统审计。内存限速窗口沿用各限速器自身的容量和到期处理；不另建表。

正式证据引用、抽取运行引用、必要撤销、抑制及合法退订绑定优先保留。发生项及其展开记录保留为去重锚，不能因 Delivery/批次清理而重新展开。未完成、unknown/deferred 邮件和关联反馈保留待对账。新清理不会删除公共更正层；其 retain_until 与分页清理由既有日历发布执行器负责。Push（ADR-0025）：租期到期转 paused（`lease_expired`），暂停或失效超过 `PUSH_STALE_GRACE`（单位天，换算在 contracts `pushStaleCleanupBefore`；原实现误按秒换算，已修正）后删除，激活截止已过的 pending 直接删除；结束的 `push_messages` 与 Delivery 同一期限清理，仍有未完成 Push 外发的 Delivery 保留。

本地合成数据测试和 rows_read 只证明当前访问形状；目标平台成本/账单仍交 P5-04 取证。没有操作生产数据、发信或部署。迁移仅增加索引；代码回滚不能恢复已清除的到期数据。
