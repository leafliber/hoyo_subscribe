# 合同基线索引

> **这份文件不是合同**，是把主方案 v2.1 与前端 v1.0 中跨阶段反复使用的枚举、公式与边界集中到一处，避免执行者每次通读 160 KB。
> 每条都标注了合同出处。**有任何歧义，回到出处原文**；本文件与原文冲突时以原文为准，并同时修正本文件。

## 1. 枚举（§3.3）

| 维度 | 取值 |
| --- | --- |
| 事件类型 | `livestream` / `maintenance` / `limited_event` / `gacha` |
| 节点类型 | `start` / `end` / `phase_unlock` / `reward_deadline` / `expected_end` / `actual_end` |
| 审核状态 | `pending` / `approved` / `rejected` |
| 事件状态 | `scheduled` / `postponed` / `cancelled` / `retracted`（`retracted` = 本站纠错，**不是**官方取消） |
| 时间依据 | `official_explicit` / `deterministic_derived` / `official_estimate` / `unresolved` |
| 时间精度 | `datetime` / `date` / `unknown` |
| 订阅行状态 | `uninitialized` / `initialized`（单向，§4.4、§5.1） |
| 会话状态 | `pending` / `active` / `revoked`（§4.5） |
| 发送状态 | `pending` / `leased` / `calling_provider` / `accepted` / `retry_wait` / `unknown` / `deferred` / `bounced` / `failed` / `complained` / `rejected` / `skipped` / `superseded` / `expired`（§7.4） |

**只有精确、证据通过的明确时间或确定性推导可用于提醒**；预计与未知时间可在 Web 标注但不冒充精确提醒（§3.3）。

## 2. 凭证与授权边界（§1.3）

| 凭证 | 能做什么 | 绝对不能做什么 |
| --- | --- | --- |
| 登录会话 Cookie `__Host-session` | 管理本人资源 | 不进 URL / localStorage / 导出 |
| 预认证 Cookie `__Host-preauth` | 绑定挑战与 CSRF | 不升级为正式会话 |
| Feed token | 只读日历 | 不授权账号操作 |
| 退订 token | 关闭**对应地址**的业务邮件 | 不读写账号 |
| Push receipt token | 确认本浏览器接收 | 不取邮箱、不改账号、不管别的设备 |
| 恢复码 | 紧急停用（**不消费**）/ 恢复登录（消费一次） | 不证明新邮箱所有权 |

退出本机、关闭邮件、暂停浏览器通知、停用日历、删除账号是**五个不同操作**，互不连带。

## 3. 订阅配置模型（§5.1）

```json
{
  "schema_version": 3,
  "revision": 1,
  "scope": {"games": ["genshin","hsr"], "regions": ["CN"]},
  "calendar": {
    "event_types": ["livestream","maintenance","limited_event"],
    "node_types": ["start","end","reward_deadline"],
    "alarms_enabled": true
  },
  "notifications": {
    "rule_ids": ["livestream_start_1h","limited_end_1d"],
    "new_event": false, "important_change": true,
    "cancelled_or_retracted": true, "late_discovery": true
  }
}
```

- 上例**只表示结构**，初值见附录 A.1。数组为有限枚举，去重排序，拒绝未知键与额外层级。
- `scope` 与 `calendar.event_types` **非空约束只对 `initialized` 成立**。
- `notifications.rule_ids` **可以为空**，且为空时变更开关必须仍可开启（§5.3）。
- `email_channels.routine_enabled` 属于通道状态，**不进订阅 JSON**（§7.5）。
- 邮件 enabled、设备权限、Feed 状态是独立服务状态，不由 JSON 里的布尔值冒充。

## 4. 四类设置的作用域（§5.1、§5.3；前端 §3.2）

```text
scope                          → 同时限制日历与通知的游戏/区域
calendar.event_types/node_types→ 仅控制基础可见节点
notifications.rule_ids         → 精确提前提醒的唯一业务选择源
                                 （发送资格【不】与 calendar.node_types 隐式相交）
变更通知范围 = scope ∩ ( calendar.event_types ∪ rule_ids 所涉及的事件类型 )
```

取并集的理由：日历里看得见的事件出了变化该被告知；只选了提醒规则、没把类型放进日历显示的用户也不该漏掉取消。

## 5. 日历投影（§5.2、§6）

```text
有效日历节点 = 基础可见节点 ∪ 当前提醒规则需要的节点
              （均受 scope、时间依据及第 6 章窗口合同约束）

UID      = feed_namespace + milestone_id + 固定日历命名空间
SEQUENCE = public_ical_revision(milestone) + view_revision(feed)
```

- 提醒所需但被基础筛选隐藏的节点显示为**"提醒关联节点"**，沿用同一 Milestone/UID，不另造重复事件。
- 只对合法精确节点嵌入 DISPLAY VALARM；同节点相同提前量去重；预计与未知节点不生成精确闹钟。
- 基础窗口 `FEED_PAST_DAYS` / `FEED_FUTURE_DAYS`，按固定 UTC 日桶；纯日期节点按保存的日期语义判断。
- DTSTAMP/LAST-MODIFIED 取实际公共/Feed 变更时间，**不每次设为 now**。
- SEQUENCE 按协议非负整数范围校验，接近上限**停下并迁移，不回绕**。

### 5.1 共享更正层（§6.3）

| 变化 | 当前响应 |
| --- | --- |
| 有明确新时间的改期 | 同 UID 输出真实新时间 + 更高公共版本 |
| 改期越过基础窗口未来端 | 保留期内仍通过共享层输出真实新时间 |
| 官方取消 / 系统撤回 / 节点删除 / 延期但新时间未知 | 用最近已发布时间输出 CANCELLED，分别说明事实原因，**不虚构新日期** |
| 分类/归属纠正 | 新分类显示正确节点；旧分类按完整快照删除语义移除 |
| 纯自然窗口退出或用户隐藏 | 从完整快照移除，**不伪称官方取消** |

**更正层条目与基础节点走同一套用户筛选**——用户隐藏了某类节点，就不该凭空收到该类型的"已取消"条目。更正层是共享存储，不是绕过筛选的旁路。

保留截止 = `max(最后更正时间 + CAL_PATCH_MIN_DAYS, 仍需覆盖的旧节点最晚时间 + CAL_PATCH_TAIL_DAYS)`。连续改期累计旧时间水位。

### 5.2 缩水守卫（§6.5）

```text
若  本次条目数 相对 last_served_node_count 下降 > FEED_SHRINK_GUARD_RATIO
且  view_revision 未变
且  公共代次无对应的取消/删除/窗口推移证据
且  条目数 >= FEED_SHRINK_GUARD_MIN
则  拒绝返回该响应 → 503 + 告警
```

理由：完整快照下"少输出一条"等于**向客户端下达删除指令**。客户端对 5xx 的常规行为是保留上一次成功结果，正是需要的兜底。守卫只拦无法解释的收缩；用户自行缩小筛选（`view_revision` 变化）或事实确实取消（公共代次有证据）照常输出。

前端表现（前端 §9.1、U21a）：显示"本次输出未通过完整性检查，已暂停更新以保护你现有的日历内容"，给出上次成功时间与条目数、重试与联系入口；**不得显示为普通网络错误，不得建议重置地址或重新订阅**。

### 5.3 读路径（§6.6）

```text
校验方法/长度/token 规范编码
 → 主状态验证 Feed + User + token 代次 + 恢复 epoch
 → 取云配置、view_revision、当前完整发布代次
 → 只读该代次的公共快照与更正层（缓存代次不符则回源）
 → 计算基础节点/提醒关联节点，按同一筛选取更正层，组装完整 ICS
 → 再核对授权代次、配置版本、公共数据代次；变化则有界重试
 → 缩水守卫
 → 授权后处理 HEAD / ETag / If-None-Match
 → Cache-Control: private, no-store
```

个人响应不进公共 CDN；授权数据库不可用返回 503（即使有旧内容）；ETag 来自实际内容与版本，不用条目数量或请求时间。

`last_feed_poll_at` 随授权查询在同一条 D1 条件更新里完成，每 `FEED_ACTIVITY_WRITE_INTERVAL` 最多写一次；**写入失败不改变本次日历内容，但必须计入 `activity_write_failures`**，且指标异常或最近成功写入早于 `RECLAIM_TELEMETRY_STALE_HOURS` 时**全局暂停账号与席位回收**。

## 6. 通知调度（§7）

### 6.1 优先级阶梯（唯一，不由实现临时解释）

```text
取消/撤回 > 重要更正 > 晚发现 > 常规提前提醒 > 新事件公布
前三档 → 紧急池      后两档 → 基础池
```

### 6.2 同批次合并（§7.3）

- 合并范围：同一用户、同一批次、同一优先级组内所有已到期未过期候选，外加 `due_at` 落在 `MAIL_DIGEST_WINDOW` 内的即将到期候选。
- **只允许提前发送，不允许推迟任何一条**（因此不与 `REMINDER_GRACE` 冲突）。
- 合并后计为**一次**发送机会、一个 MailOutbox 意图；每条 Delivery 各自保留 `(node, schedule_revision, rule_id, channel, target)` 去重键并记录共享的 `mail_outbox` 引用。
- 跨优先级不合并。

游标在**批准一次发送尝试**时推进（unknown/失败也算已获机会）；明确失去资格则跳过、不扣机会。每个优先级/预算池单独保存游标，不按注册顺序重置。

### 6.3 晚发现（§7.2）

| 情况 | 行为 |
| --- | --- |
| 节点未发生、提前窗口已过 | 创建立即到期的 late_discovery，不超过节点时间与自身有效期 |
| 开始节点刚过、仍在补报窗口且无已确认结束事实 | 可补报"刚收录的安排已到计划开始时间"，**不声称正在进行或尚未结束** |
| 截止已过 / 已确认结束 / 陈旧回填 | 不补发 |
| 普通提前提醒仍在有效窗口 | 继续原发生项，不再生成晚发现 |

晚发现走**紧急池**（没有 VALARM 兜底）。与普通提醒共享去重族 `(node, schedule_revision, rule_id, channel, target)`。

### 6.4 邮件两层（§7.5）

| 层 | 内容 | 默认 | 名额 | 池 |
| --- | --- | --- | --- | --- |
| 邮件席位 `email_channels.enabled` | 取消/撤回、重要更正、晚发现 | 用户同意后开启 | `MAIL_SEATS_MAX` | 紧急池 |
| 常规提醒邮件 `routine_enabled` | 常规提前提醒、新事件公布 | **关闭** | `MAIL_ROUTINE_SEATS_MAX`（席位子集） | 基础池 |

第二层默认关闭的理由：`CALENDAR_ALARMS_DEFAULT = true` 之后，启用了个人日历的用户本地已收到同一提醒，再发邮件是重复。

## 7. 预算（§9.1、§9.2）

### 7.1 基础池 envelope（**必须带 carry 与 E=1**）

```text
R     = max(0, 池月上限 - 已结算 - 未决预留 - 不确定占用)   （建立本片段前）
D     = 本周期尚余 UTC 日片段数，含当前片段
carry = 上一片段未发放的小数余额（同池持久保存，初值 0）

E_raw = R / D + carry
E     = min(池日硬上限, floor(E_raw))
carry = E_raw - E    （仅在未被日硬上限截断时累积）
若 R > 0 且 E = 0，则 E = 1

片段可批准 = E - 本片段已批准且未释放的占用
实际可批准 = min(片段可批准, UTC 日各级剩余额度, 平台可用额度)
```

纯 `floor(R/D)` 会在池子见底时归零（R=20、D=25 → 0），把余额永久吞掉。正确行为是**随额度减少平滑降频**。

### 7.2 紧急池：**不做 envelope**

直接按月池消耗；`MAIL_URGENT_DAY` 须足以覆盖 `MAIL_SEATS_MAX` 的一次全量取消。月池剩余跌破 `MAIL_URGENT_FLOOR` 后收紧为只发取消/撤回。

### 7.3 认证池：不排队，但有下限

```text
软线 S = 该池剩余月额 / 本周期尚余片段数

本片段认证已用量 > S ：同一规范邮箱当日第二次及以后的发送意图降级为稍后重试并延长冷却；
                      剩余额度优先留给本片段尚未取得任何验证码的邮箱
剩余月额 < MAIL_AUTH_FLOOR ：只接受既有账号的首次登录意图；
                      暂停新注册发信与全部重发；页面明确标示认证降级
```

**恢复入口不依赖发信预算**——这是认证降级期间用户仍能取回控制权的唯一保障。

## 8. 认证与会话时序（§4.3、§4.5、附录 A.5）

```text
PREAUTH_MIN_TTL >= OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN
OTP 绑定 Cookie 截止 >= 最晚挑战截止 + AUTH_COMPLETION_TTL + PREAUTH_MARGIN

SESSION_ABSOLUTE_TTL - SESSION_ABSOLUTE_JITTER > SESSION_IDLE_TTL > SESSION_RENEW_INTERVAL
SESSION_IDLE_TTL > SESSION_EXPIRY_NOTICE
```

**"真实前台操作"的定义（不留给实现解释，§4.5、前端 §12.2）**：用户在本会话中完成一次**显式的状态变更或账号管理请求**——保存订阅、启用/停用通道、管理会话或设备、换邮箱、轮换恢复码、导出数据——之后前端可发起一次续期 POST。

**不算**：页面加载、被动 GET、路由切换、返回前台、预取、可见性事件、后台标签页、Service Worker、外部日历拉取、收到邮件。

绝对期限在**创建会话时**取 `SESSION_ABSOLUTE_TTL ± SESSION_ABSOLUTE_JITTER` 内的随机值并固定写入（摊平上线期集中到期）。认证预算按 `min(抖动后绝对期限, SESSION_IDLE_TTL)` 估算，**不按绝对期限**（§9.3）。

## 9. 恢复码（§4.6）

| 动作 | 是否消费恢复码 | 之后 |
| --- | --- | --- |
| 紧急停用 | **否** | 撤销所有会话与 Feed、关闭业务邮件、暂停 Push；不返回任何私人数据；幂等；受 `RECOVERY_ATTEMPTS_HOUR/DAY` 限制 |
| 恢复登录 | **是** | 执行同样的安全暂停 → pending 恢复会话 → 激活后**立即交付新恢复码**；在用户完成保存确认前**只允许查看、导出、保存新码、删除账号**，不得启用通道或换邮箱 |

`recovery_id` 与秘密一起校验，单独提交 `recovery_id` 不得产生存在性差异。

## 10. 提醒规则注册表（附录 A.6；前端 §6.2 文案映射）

| rule_id | 事件类型 | 节点 | 提前量 | 用户文案 |
| --- | --- | --- | --- | --- |
| `livestream_start_1h` | livestream | start | 3,600 s | 前瞻开始前 1 小时 |
| `maintenance_start_1h` | maintenance | start | 3,600 s | 维护开始前 1 小时 |
| `limited_start_1h` | limited_event | start | 3,600 s | 限时活动开始前 1 小时 |
| `limited_end_1d` | limited_event | end | 86,400 s | 限时活动结束前 1 天 |
| `gacha_start_1h` | gacha | start | 3,600 s | 卡池开始前 1 小时 |
| `gacha_end_1d` | gacha | end | 86,400 s | 卡池结束前 1 天 |
| `phase_unlock_1h` | limited_event | phase_unlock | 3,600 s | 活动阶段解锁前 1 小时 |
| `reward_deadline_1d` | limited_event | reward_deadline | 86,400 s | 奖励领取截止前 1 天 |

规则 ID 一旦发布**不得改成另一种提前量**；新增语义用新 ID。"前 1 天"沿用固定提前量，**不改成前一日零点**。

## 11. 附录 A.5 启动等式（`pnpm params:verify` 必须实现全部）

```text
MAIL_TOTAL_MONTH = MAIL_EXISTING_AUTH_MONTH + MAIL_SIGNUP_AUTH_MONTH
                 + MAIL_BASE_MONTH + MAIL_URGENT_MONTH
MAIL_TOTAL_DAY   = MAIL_AUTH_DAY + MAIL_BASE_DAY + MAIL_URGENT_DAY
MAIL_SIGNUP_AUTH_DAY <= MAIL_AUTH_DAY
MAIL_AUTH_FLOOR   < MAIL_EXISTING_AUTH_MONTH
MAIL_URGENT_FLOOR < MAIL_URGENT_MONTH

MAIL_ROUTINE_SEATS_MAX <= MAIL_SEATS_MAX
MAIL_BASE_MONTH >= MAIL_ROUTINE_SEATS_MAX × 本账单周期相交UTC日期数 × MAIL_USER_BASE_DAY
MAIL_URGENT_DAY >= MAIL_SEATS_MAX × 1

MAIL_DIGEST_WINDOW 只用于提前发送；合并后任一条的实际发送时间不得晚于其自身 expires_at

PREAUTH_MIN_TTL >= OTP_TTL + AUTH_COMPLETION_TTL + PREAUTH_MARGIN
OTP绑定Cookie截止 >= 最晚挑战截止 + AUTH_COMPLETION_TTL + PREAUTH_MARGIN

SESSION_ABSOLUTE_TTL - SESSION_ABSOLUTE_JITTER > SESSION_IDLE_TTL > SESSION_RENEW_INTERVAL
SESSION_IDLE_TTL > SESSION_EXPIRY_NOTICE

DELIVERY_DEDUPE_TTL > 业务发生项最大有效期 + 最大重试余量
0 < FEED_SHRINK_GUARD_RATIO < 1
各预留包含于对应总量；pending <= total；价格/usage 单位一致
```

## 12. API 分组速查（§8.2）

| 路径组 | 要点 |
| --- | --- |
| `/api/v2/catalog、events、status` | GET 公开；不创建身份；`/status` 公布全局 `registration_open`，**不提供按邮箱查询是否注册** |
| `/api/v2/auth/preauth` | POST 同源初始化预认证 Cookie/CSRF |
| `/api/v2/auth/challenges`（+ `resend` / `verify`） | 用途、预占、限额、浏览器绑定 |
| `/api/v2/auth/complete` | 原 preauth + 操作键领取未激活的短期完成结果 |
| `/api/v2/auth/activate、renew、logout` | pending 激活 / 低频续期 / 仅撤销当前会话 |
| `/api/v2/auth/recovery` | `emergency_stop` 幂等且**不消费**；`recover_login` 一次消费并立即交付新码 |
| `/api/v2/me、me/sessions` | 本人资料 / 脱敏会话；DELETE 指定本人会话 |
| `/api/v2/me/subscription` | GET/PATCH；`expected_revision`；所有者服务端派生 |
| `/api/v2/me/calendar` | GET 专用 URL；enable/disable/reset 为 POST；**统一会话权限，不额外要求 OTP** |
| `/feeds/u/{token}.ics` | GET/HEAD；只读能力鉴权；304 同样授权；无交互挑战 |
| `/api/v2/me/email-channel` | GET/PUT；两层同意；子名额满时**只拒绝第二层**；不能借此更换收件地址 |
| `/unsubscribe/{token}`、`/email/one-click/{token}` | GET 仅展示；POST 退订；one-click 无登录依赖、不重定向 |
| `/api/v2/me/push-bindings`、`/api/v2/push-bindings/{id}/activate、processed` | 本人归属 vs receipt 窄能力 |
| `/api/v2/me/email-change、recovery-code、delete` | 用途限定的最近认证 |
| `/api/v2/me/export` | 本人配置及必要数据，不导出秘密 |
| `/api/v2/admin/*` | 独立管理员会话与审计 |
