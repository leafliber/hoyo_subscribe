# P5-01 观测与开关实现清单

依据主方案 §10.1（邮件口径按 ADR-0003 修订）、D3 §2.1、任务卡历史交接及 #72 的 08c5b9d 开工纠正。
这是模块设计清单；交付报告与运行日志只放 PR。

## 指标与事实来源

| 指标 | 来源 | 既有参数 / 告警 | 缺失行为 |
| --- | --- | --- | --- |
| 认证总池及注册子池、基础池、紧急池余额 / 耗尽时刻 | usage_periods + 原子预占观测 | MAIL_AUTH_DAY / MAIL_SIGNUP_AUTH_DAY / MAIL_BASE_DAY / MAIL_URGENT_DAY；两个 MAIL_*_FLOOR | 查询失败 unknown；从未建行的日账本按账本定义零占用；未观测到耗尽不能捏造时刻 |
| 缩水拦截数及响应 | Feed diagnose/shrink_guard 的匿名计数 | 单次即告警 | 未采集 unknown；不保存 Feed 标识 |
| 活动水位失败 / 暂停回收 | activity_write_failures + readReclaimGate | RECLAIM_TELEMETRY_STALE_HOURS | 缺失按暂停，失败数 unknown |
| 每封承载 Delivery 数 | calling_provider 边界匿名计数 | 无业务质量阈值，不自定低合并率阈值 | 分母零或未采集 unknown |
| 自动续租 / 实际释放比例 | renewEmailSeat 成功；未来 P5-02 释放事件 | 不提前实现回收；未运行明确 unknown | 未采集 unknown，不把无人回收记为健康 |
| 认证排队、账户/席位、优先级等待/跳过原因 | mail_outbox / capacity_state / email_channels / deliveries | 现有存量与邮件期限 | 失败独立 unknown |
| 退订处理延迟 | 退订处理成功后的匿名耗时 | 无已批准延迟阈值 | 未采集 unknown |
| 来源截断 | source_response_truncated，按注册表官方主机聚合 | SOURCE_LIMIT_PROFILE；单次告警 | 不记录 URL/正文，不抬上限 |
| 管线滞后 | snapshot_rebuild outbox、构建失败计数 | FEED_MAX_STALE；失败即告警 | 失败 unknown，不由来源水位冒充管线健康 |
| 邮件 unknown / 抑制 | provider_unknown 计数、mail_outbox / suppressions | 单次告警；不全局暂停 | 失败 unknown |
| 反馈容量 / 未关联到期增长 | mail_feedback、mail_feedback:unmatched_expired:* | MAIL_FEEDBACK_MAX / MAIL_UNMATCHED_MAX；OBS_CAPACITY_WARN_RATIO（所有者批准） | unknown，不能显示零积压 |
| 重试未安排 / 业务预算与派发失败 | mail_retry_budget_not_scheduled、固定日志与 failed jobs | 单次告警；保持认证独立 | unknown |
| 投递终态（含执行器核心 `delivery:backoff` 与发生项退避） | `failed_jobs`（固定清单，含 last_error/attempts/updated_at） | `delivery_failed_jobs` 按当前状态持续告警，解除后清除 | unknown |
| 来源维护锁 / 来源待办终态 | `source_states`（注册表来源 × sources × `pipeline:source:*`） | `source_maintenance:<id>`、`source_job_failed:<id>` 按当前状态持续告警 | unknown |
| CPU / D1 读写存储 / DO / Queue / DLQ / 账单 | 所有者提供的真实平台事实 | 包含量和观测时间必须随证据；不采用本地值冒充 | unknown + 待取证，不请求平台权限 |
| 公开来源 / 代次 / 缺口 | 沿用 P3-14 公开视图 | 沿用其保护值 | 按其逐项 unknown |

## 独立开关

全部值存 system_state；读取仅接受 JSON boolean，管理写入必须管理员会话、绑定 CSRF、理由和同事务审计。

- registration_open：复用原键；缺失准入关闭。
- mail_sending_available：复用原键，控制全部邮件外发；全部外发总门另覆盖 Push/模型/来源请求。
- outbound_enabled：全部外发；缺失关闭。
- email_seats_open / email_routine_enabled / business_mail_enabled：新名额、常规层、业务邮件分别控制；关闭不修改用户同意。
- push_enabled / model_enabled / automatic_publication_enabled：独立门；未实现的 Push/模型不得宣称已可用。
- review_skip_enabled（P3-25，ADR-0018）：「跳过审核」，只在 AI 草稿可用时生效。首次部署后才加，没有记录时按合同默认值读作关闭（`OPERATIONAL_CONTROL_DEFAULTS`，只能是 false），读取出错仍是 unknown；管理端以版本 0 写入首行。
- source:<注册表 source_id>：逐来源 boolean；仍保留访问控制维护锁，不自动解除。

## 终态解除（所有者有意操作）

只接受管理员会话、绑定 CSRF、闭合原因（OperationalReasonSchema）与 `expected_updated_at` 乐观并发；业务写入与审计同批，零命中返回 409。

- `POST /api/v2/admin/sources/resume` `{source, expected_updated_at, reason}`：仅 `maintenance-required` 且来源待办不在租约中时，恢复注册表登记状态，丢弃残留抓取页并只放回一次正常受控轮询；仍受限时同一抓取重新标维护并告警。不做周期探测，不绕过官方访问控制。
- `POST /api/v2/admin/delivery/rearm` `{job, expected_updated_at, reason}`：只接受固定清单中的 failed 行；退避行置 done 解除，`delivery:dispatch` 回到 pending 续跑同一批。不修改 `mail_sending_available`，开启外发仍是单独一步（顺序见 `mail/outbox/README.md`）。
- 逐封、逐发生项与发布/通知待办的 failed 不提供批量重置。
- account_reclaim_enabled / seat_reclaim_enabled：各自的运营门；不替代 reclaim_paused 的活动可靠性门，不实现回收。
- read_only：维护开关；只限制扩大/修改，退订、停用、撤销、删除及管理员恢复操作保留。
- calendar_enabled：D3 日历启用事实；不影响有效个人 Feed 的读取与停用。

公开只导出已有 capabilities 的 open/closed/unknown，不输出预算或私人数据。缺失值保持 unknown；执行时失败关闭（只读维护未配置不自行宣称开启）。

## 接线与验证计划

contracts：闭合枚举、严格 schema、纯事实推导；Worker 管理 GET/PUT、CAS 与审计、公开白名单；模块在准入及实际执行前重查；既有终止路由不受开关拦截。
反馈定时维护按 FEEDBACK_BATCH 分页，最多 FEEDBACK_MAINTENANCE_ROUNDS 轮且在 EXECUTOR_BATCH_WALL_LIMIT 内推进，不因无 Queue 流量漏清理/再关联。
统计键只使用固定指标和注册表主机，固定槽更新，不引入逐请求记录或无限时间桶。
测试：默认 unknown、独立开关、最终发送拦截、终止可达、管理员权限/CSRF/CAS/审计回滚、日边界/floor、每条历史告警、反馈无流量维护与墙钟边界、公开无秘密。

耗尽观测使用 0025 的固定槽触发器，SQL 由 `pnpm exec tsx scripts/migrate/observability.ts` 从 contracts 生成。
不回填迁移前历史，也不把最后更新时间当首次耗尽时间；同日释放后重耗尽不覆盖首次时间，旧日不能覆盖新日。
所有者批准的两个新参数分别约束容量预警和维护轮数；不改硬配额或既有每十分钟 Cron。
