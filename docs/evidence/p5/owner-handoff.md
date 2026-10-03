# P5-04 所有者取证与关闭门部署清单

本清单是待执行步骤，**本 Agent 未部署、未操作 Cloudflare、未真实发信或清理生产数据**。本地报告不代表平台已放行。正式 origin 已定为 `https://hoyo.airo.cc`，本轮不重复请求参数裁定。首版无模型和 Push；新资源、权限、参数或超套餐费用不能自行增加。

## 2026-10-03 所有者已提供的首次部署信息

| 项 | 已确认值 / 当前状态 |
| --- | --- |
| Worker | 尚未创建；所有者已确认名称改为 `hoyo-subscribe`，替代最初的 `hoyo_subcribe`。官方配置文档要求名称不含下划线 |
| D1 | 所有者已创建并确认空库；名称 `hoyo-d1`，真实 UUID 与所属账户 ID 已由所有者提供并填入源码外私有配置，绑定仍为 `DB`。Agent 未读取远端核验 |
| 正式域名 | `https://hoyo.airo.cc`，所有者确认当前没有其他网站，可由其配置 DNS/Worker 域名 |
| Turnstile | 已有组件；公开 Site Key 为 `0x4AAAAAAFMspypfMWsFcEg1`。允许主机名包含 `hoyo.airo.cc` 尚待所有者确认，secret 配对和目标实测尚未完成 |
| 备份 | 所有者选择本地备份，但存放位置与独立副本尚未准备。仍须按备份手册落实加密磁盘、独立离线副本、解密/业务恢复材料与当前 epoch 分离保管 |

**眼下可做的操作：**D1 已创建且账户映射已给齐，无须重建。在已有 Turnstile 组件的设置中确认允许主机名包含 `hoyo.airo.cc`，不需要提供 Secret Key。保留现有组件及 clearance 设置。暂不把空白示例 Worker 当作本项目部署、不把未迁移的数据库连接到公开入口。后续从已验收构建按下方关闭门步骤首次部署 `hoyo-subscribe`，由所有者执行。

并行代码工作只有 P2-01 的 Turnstile 接入维护，见 [卡上 2026-10-03 上线接入复核](../../tasks/P2.md)。当前生产校验器仅判 success，不核对 hostname/action；独立探针已确认，修补通过前正式认证仍不放行。卡数仍按历史交付统计，不把维护项隐藏在“69/69”里。

公开构建变量已经过本地检查，仍需在**每次正式前端构建前**设置；只在 Worker 运行时设置同名变量不会修改已生成的网页：

```sh
CI=1 WRANGLER_SEND_METRICS=false PUBLIC_TURNSTILE_SITE_KEY=0x4AAAAAAFMspypfMWsFcEg1 pnpm --filter @hoyo/web build
```

验收方已在源码外生成关闭门配置模板，保留两固定 DO 与静态路由，移除首轮 send_email/Queue 消费者/Cron，设置上述 Worker/D1 名称和 SITE_ORIGIN，禁用 workers.dev/preview_urls。收到所有者提供的真实账户与 D1 映射后已填入模板并重新验证，锁定 Wrangler 4.136.0 的 `deploy --dry-run` exit 0（外层 300 秒未触发）。另在新建临时本地 D1 完整应用 0001–0026，并从 policy 输出生成首次空库初始化 SQL：18 项控制状态正确，重放写入 0 项；仅 read_only/reclaim_paused 为 true。初始化会在已有 system_state 或账号时拒绝写入，不能以 0 行当首次成功。相关文件和所有者操作步骤留源码外；仅私有配置保存真实平台 ID。本地验证不证明远端已执行，正式认证还须待修补；更换提交后需重建并同步配置路径。

此命令仅含公开 Site Key。Secret Key 只存 Worker 的 `TURNSTILE_SECRET_KEY`，不得进入 `PUBLIC_*`、前端构建变量、Git、PR、日志或对话。

按所有者指定的 [Turnstile Spin 已有组件流程](https://developers.cloudflare.com/turnstile/spin/prompt.md)，Worker 尚不存在且没有已确认的其他秘密目的地时，Agent 在取回 secret 之前停止。首次关闭门部署形成真实 Worker 后，由所有者在 Cloudflare 的 Worker 设置中以 **Secret** 类型注入 `TURNSTILE_SECRET_KEY`；只反馈绑定已设置，不反馈值。若之后改由 Agent 自动恢复 secret，则另需确认源码外可信 Wrangler 的绝对路径及精确版本、账户、配置/环境、目标 Worker/binding 和域名清单，展示写入清单并获明确确认；不得使用项目内 `pnpm exec`/`npx` 跑该 secret getter 或写入。本段专指 Turnstile 自动秘密恢复，不把后文既有部署命令算作本轮执行过。

设置绑定不代表验证通过：目标后端还须真实新 token 成功一次、同 token 重放拒绝，并记录日期及部署 commit。本轮没有真实 token、Widget 元数据、云端部署或该验证证据，不得写成 end-to-end 已完成。认证发信仍受原先指定地址和关闭门取证流程约束。

依据：[Worker 名称约束](https://developers.cloudflare.com/workers/wrangler/configuration/#inheritable-keys)、[D1 首次创建与绑定](https://developers.cloudflare.com/d1/get-started/)、[Siteverify 校验](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)。本段不授权 Agent 操作 Cloudflare，也不改变套餐费用边界。

## 先准备证据，不先开放能力

记录最终已验收 commit、依赖 PR、最大迁移号和构建摘要。本卡开工 main efb320e，最大 0026；本卡没有迁移。之后 main 更新仍按实际代码执行 migrate:check 和备份演练，不能固定拿旧号部署。F3-04/F3-05 前端全链和本表 E3 均完成前，不开放正式用户流程。

在所有者私有环境保存：平台账户/现有项目及 D1 映射、两个固定 DO 身份、Queue/DLQ、域名、计划包含量与其他应用占用。仓库 D1 零 UUID 是占位，不能直接部署。秘密、邮箱、Feed/退订 URL、原始头、Cookie、messageId 及完整账单留源码外；仅把日期、commit、聚合、证据摘要与结论交验收方。

```sh
# 以下三项仅本地读取/验证，无远端操作。
CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx scripts/load/policy.mjs
CI=1 WRANGLER_SEND_METRICS=false pnpm params:verify
CI=1 WRANGLER_SEND_METRICS=false pnpm migrate:check
```

policy 输出当前注册表数值、全部关闭门目标及每个来源 ID，不把文档写成第二套配置。缺新的真实参数时先由所有者裁定，工具不代填。旧 P0 的零其他占用不能当成本次账户事实。

## 关闭门部署的具体顺序（仅所有者执行）

1. **已有部署先关门，空库先初始化关闭状态。**既有服务通过管理员会话 + 会话绑定 CSRF 读取 `GET /api/v2/admin/controls`，逐项 `PUT /api/v2/admin/controls` 提交 `{control, enabled, expected_updated_at, reason}`；来源项另含 source。目标来自 policy：registration_open、mail_sending_available、outbound_enabled、业务/常规邮件、新席位、日历启用、Push、模型、自动发布、账号/席位回收、每个来源全部 false，read_only=true。每次成功后重新 GET 核实实际值；409 重新读版本，不能盲覆盖。既有 true 不能靠新代码“缺省关闭”覆盖。控制面不可用时先由所有者隔离入口及旧执行器，保持真实外发绑定脱离，不能继续公开迁移。空库应用迁移后、连入口前，以 policy 目标初始化 system_state（另 reclaim_paused=true）；这仅为首次空库引导，既有库必须使用受控审计路径。
2. **在源码外准备正式配置副本。**从 `apps/worker/wrangler.jsonc` 复制并修正配置相对路径：main 指向已验收 `apps/worker/src/index.ts`，assets.directory 指向本次 `apps/web/dist`，migrations_dir 指向本次 migrations；永远不能指向 scripts/load/worker.ts。替换为所有者已核实的项目名和 D1 ID；保留两个 DO 类/迁移及单 Worker 拓扑，不新建按用户 DO。配置 origin、AUTH_MAIL_FROM、BIZ_MAIL_FROM 与各用途允许发件地址一致。首轮取证准备暂不附加 send_email、Queue 消费者和 Cron，先验证关门与静态/只读入口；之后按批准配置逐项恢复，这不是删生产业务代码。禁用 workers.dev/预览域的意外公开面（按既有项目实际设置核对），正式域名所有路径进入同一项目。唯一 _redirects 原样使用，不加第二套平台改写。
3. **迁移后再发布匹配代码。**使用锁定 Wrangler 在 Worker 目录执行，下面命令本轮均未执行；变量由所有者私有环境提供，配置不能含明文 secret：

```sh
CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler d1 migrations list DB --remote --config "$P504_DEPLOY_CONFIG"
CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler d1 migrations apply DB --remote --config "$P504_DEPLOY_CONFIG"
# 完成空库关闭门初始化，或核实已有库全部关闭后再部署。
CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --config "$P504_DEPLOY_CONFIG"
```

已有数据迁移前按备份手册保存独立可验证备份；不 DROP、不重排历史编号、不代清理生产。正式构建前设置公开 `PUBLIC_TURNSTILE_SITE_KEY`，站点域名在 Turnstile 白名单；Worker secret 与之配对。`CRYPTO_MASTER_SECRET`、`CRYPTO_OTP_PEPPER`、`CRYPTO_UNSUBSCRIBE_KEY_ID`、`TURNSTILE_SECRET_KEY`、`ADMIN_BOOTSTRAP_SECRET` 按部署前置使用 `wrangler secret put <NAME> --config "$P504_DEPLOY_CONFIG"` 的安全输入注入，值不写命令、配置、PR 或截图。兼容旧退订 key ID 集合按既有规则配置。根材料与离线恢复材料由所有者保管；不能为方便换根造成旧身份丢失。
4. **先核对可关闭，再配置后台。**检查 `/`、`/help/`、`/status/`、任意事件直达、`/admin/` noindex、静态文件；未知路径 404；动态 API/Feed/退订不能被 HTML 覆盖。公开状态注册/邮件发送必须关闭，各能力 unknown 也不得当作已开放。核实管理员会话、绑定 CSRF、CAS、理由和审计正常，必要终止入口（退订、停用、撤销、紧急停用、删除）在 read_only/外发关闭时仍可执行。不能用真实账号删除来压测。按 DEPLOYMENT_PREREQUISITES 配置 API/管理员按 IP 边缘限速，不能以应用邮箱限速代替。
5. **Queue/DO/Cron 逐项取证。**核实既有 `hoyo-mail-events` 的账户/订阅 ID 和业务/认证域映射、DLQ 是否已到位；不足由所有者按原授权处理，不擅自新建产品。先摘掉 HTTP pull 消费者，再将唯一消费者切换为此 Worker；不能两个消费者并存。配置 `MAIL_FEEDBACK_ACCOUNT_ID`、`MAIL_FEEDBACK_SUBSCRIPTIONS`，未配置时重试/DLQ 不是成功消费。认证域订阅须单独到位。记录重试、积压、DLQ 转移与受控重驱、去重/抑制；恢复 Cron 与两固定 DO 后，在关闭外发门下验证 watchdog 补 alarm、旧租约拒绝、执行位置。保留实际时间与平台度量，不能用本地 maintenance 数值充当这些结果。
6. **真实发信另受原地址授权和费用门约束。**本卡不扩大授权、不发送。只有所有者在已批准的准确收发范围内才做绑定路径认证时延/反馈取证；先核对当日平台动态权限、其他应用占用与注册表，不能通过开放普通业务发送顺带取证。认证信不得带业务退订头。有效业务 DKIM 的 h= 必须同时覆盖 List-Unsubscribe 与 List-Unsubscribe-Post；单独 DKIM pass 或认证信通过不够。依然不对真实用户群发做压力测试。
7. **最后才审定开放。**完成下表 E3、实际独立备份和前端首次保存→恢复码→完整预览→启用→客户端链验收，由验收方给出放行结论、所有者逐门开放；不以这份清单或 counts_match 自行开放。任一前置失败维持注册/外发关闭，公开页如实显示限制。

## E3 取证表：本轮每项均未执行/未知，需所有者提供

| 项 | 具体证据与配置来源 | 完成条件 |
| --- | --- | --- |
| Workers | 目标 commit、观测 UTC 起止、静态与动态请求数、目标计费 CPU、账户总用量/其他应用/包含量/账单项；记录冷启动与热读各样本 | 单独归因；本地 wall/Node CPU 不能代替计费 CPU |
| D1 | 同一观测窗口 rows_read/rows_written/存储、CAS 触发器 + SELECT changes() 事务行为；来源/预览/Feed/满轮维护各测量 | 不把逻辑修改次数当 rows_written；同时记录触发器/索引写和失败 |
| DO | PipelineDO/main、DeliveryDO/main 请求/时长/存储、alarm/watchdog、发送所在运行时、旧租约拒绝 | 没运行的 DO 行为保持未知，不能拿类声明当证据 |
| Queue | 操作量、重试、重复、未匹配、DLQ 积压/保留期/重驱，唯一消费者切换时间 | 重试是操作量组成部分，不与总量重复相加；DLQ 不当发信队列 |
| 邮件日池 | 同一 UTC 日 usage_periods 四用途全局行 + outbox/可信反馈终态；跨日接受按 messageId 私下关联后聚合；平台账户/其他应用/本应用接受量与日权限 | 区分 settled/reserved/uncertain；明确拒绝也 settled；跨日/unknown 差额逐项解释，不擅自退款 |
| 官方来源 | 目标 Worker 对已批准来源可达性、载荷/截断/游标及最后成功；米游社继续维护 | 遇访问控制停止，不伪装 UA 或换聚合后端；跨年样本仍缺则公开限制 |
| 邮件实际体验 | 认证绑定路径发送/接受/送达/反馈时间；业务退订头有效签名覆盖 | 仅已授权地址，原始头和关联 ID 留私有位置；accepted 不当送达 |
| 独立备份 | 本地加密磁盘 + 独立离线副本真实到位、读回 verify、当前份数/周期、密钥及当前 epoch 分离 | 依 [备份恢复手册](../../runbooks/backup-restore.md)；Time Travel 不替代；VAPID 首版不适用 |
| 目标恢复 | 导出阻塞、导出/恢复耗时、旧会话/恢复码/Feed/通知不复活、最新撤销与 SEQUENCE 高水位、DO/Queue/DLQ恢复 | unresolvedAccounts 非零不开放账号；无高水位 Feed 保持停用并明确迁移 |
| 前端与客户端 | F3-04/F3-05 全链，Apple/macOS 的版本/刷新延迟及正式站点；其他客户端独立记录 | 不外推 Google/Outlook；未知保持未知 |

平台计量维度参考 2026-10-03 核查的官方 [Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)、[DO](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Queue](https://developers.cloudflare.com/queues/platform/pricing/) 文档。文档说明计量口径，**不证明此账户包含量、折扣、实际费用或零超额**；本工具不内置猜测费率。邮件使用 ADR-0003 纯 UTC 日额度，不能复活旧合同中的月度池。

## 汇总与停止条件

所有者将同窗口脱敏聚合按 scripts/load/README.md 输入工具：

```sh
CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx scripts/load/reconcile.mjs "$P504_PRIVATE_AGGREGATE"
```

不同计费窗口、币种、日权限和已接受量不能混算；先核实单位再解释 application + other 与 account 的差值。unknown 或平台数据延迟时保留差额，不能把理论余量当账单绝对封顶。容量接近包含量时按既有开关停止低价值扩大；没有目标事实无法确认零超额，就继续关闭注册/外发，不提高上限换通过。账户包含量与硬开关组合也不能消除已在途/其他应用费用，所有者必须同时控制共享账户占用。

故障回退先关闭全部外发/注册与扩大能力，保留必要终止入口、快照与最新撤销事实，再由所有者回滚到此前已验证代码。源码基线 efb320e；**代码回滚不回退 D1、恢复 epoch、UID/SEQUENCE 或已消费预算**。本卡没有生产数据变更，不能把脚本回退当成目标库恢复。真实恢复严格按 backup-restore.md 顺序执行。
