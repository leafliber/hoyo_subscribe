# P5-03 独立备份与恢复操作手册

依据主方案 §10.2、附录 A.5、§6.4/§6.5、§7.4/§7.6 和 A-P5-BACKUP。工具仅处理本地文件，不部署、不调用外发、不创建云资源。执行入口：`CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx scripts/backup/cli.mjs`。使用仓库锁定 Node/pnpm；运行前完成 frozen install。

## 存放裁定与覆盖

本卡选择所有者本地保管兜底：私有加密磁盘上的 `.hbk`，完成校验后复制到所有者另一离线介质。现有仓库资源只有应用 D1/DO 和反馈 Queue，没有已登记可用的独立归档存储。D1 原库内复制、Time Travel、DO 状态、临时下载链接和 Queue 都不算独立备份。本卡未新建 R2、D1、KV、权限、计划或计量项；本地磁盘/介质是否实际到位仍由所有者登记。若以后需要 Cloudflare 对象存储，先独立提出资源、访问权限、生命周期、包含量与费用边界的 ADR/PR，获准后由所有者操作，不能从托管偏好推导开通权限。

已查官方 [D1 导入导出](https://developers.cloudflare.com/d1/best-practices/import-export-data/) 与 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)（2026-10-03）。官方说明运行中的导出阻塞其他数据库请求；导出 SQL 可以用于导入。目标库请求阻塞、恢复时间及费用影响必须实际测量，下面的本地演练不覆盖这些事实。没有远端查询账户或修改权限。

全量导出所有应用表，工具从当前迁移动态枚举，缺表/列/索引、迁移链改变直接拒绝，使用当前迁移重建规范 schema 与触发器：

| 组 | 内容 |
| --- | --- |
| 正式事实与证据 | sources/articles/article_versions、events/milestones、evidence、候选/抽取、event_revisions；内容 hash 用现有 articleContentHash 重算，证据外键和 block_ref 校验 |
| UID/版本与公共输出 | Feed namespace、节点 ID、三个业务版本、Feed view_revision、投影/更正/快照及缩水守卫历史；不重置 namespace，不制造新的全局取号 |
| 身份与撤销 | users、会话/认证/最近认证、恢复凭证与轮换、订阅、email_channels、consent_events、suppressions、Push 绑定表 |
| 必要运行状态 | jobs、两种 outbox、occurrences、deliveries、反馈、日池账本、公平游标、活动写失败、配额/预占、system_state、admin_sessions、audit_log |

D1 的内部 `_cf_KV` 与 `d1_migrations` 不作为应用事实备份；应用迁移文件名和 SHA-256 列表在认证加密包内，导入目标的迁移登记由所有者核实。DO alarm 和 Queue/DLQ 不在 D1 SQL 里，必须按后面的独立恢复步骤处理，不能宣称已备份它们。

周期和份数只读 contracts：

```sh
CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx scripts/backup/cli.mjs policy
```

所有者按输出的 `BACKUP_INTERVAL` 安排备份，每次完成恢复验证后保留 `BACKUP_COPIES` 个不同代次。`retention` 认证解密全部候选，报告超期、保留集及可移除集，不自动删除，不计损坏或重复文件为新代次。失败时保留上一次合格备份，记录失败并重新安排；这不是已部署的定时服务。

## 材料保管边界

备份采用独立随机 AES-256-GCM 密钥、每次随机 nonce 和固定格式 AAD；清单、schema 哈希、表数据一起认证加密。业务字段保持原密文，解包后还要用现有字段解密器验证 AAD/标签，错误密钥或搬移密文失败关闭。输出原子发布，不覆盖已有文件；输入/秘密文件要求普通文件、权限 0600、禁止符号链接和仓库内路径。CLI 只打印计数、包摘要和结果，错误统一脱敏，不打印 SQL、路径内容或原始异常。大库仍需能容纳 SQL/JSON/SQLite 的本机内存；超容量失败不覆盖上一份，目标容量由所有者实测。

| 材料 | 保管位置与用途 |
| --- | --- |
| `.hbk` | 所有者本地加密磁盘 + 离线副本；不要与下列材料放同目录/介质 |
| 备份 AES 解密材料 | 独立密码库或另一离线介质，随机原始字节文件；不得复用业务根密钥 |
| 业务字段密钥恢复材料 | 独立保管现有 CRYPTO_MASTER_SECRET 的原始字节恢复材料；只在离线验证时读取；不进备份包 |
| 退订验证密钥与 key_id 接受集合 | 独立保管相应派生材料/当前与兼容旧 ID 的保管记录；正常 ID 轮换保留原根。现有应用用同一根按 HKDF 域隔离派生，不谎称部署已有独立 secret 注入口，也不在本卡改它 |
| 当前恢复 epoch 与事故冻结记录 | **在旧快照之外**保存单调递增整数、变更记录与当前撤销证据；不可从旧库最大值单独生成并称作当前值。恢复前由所有者核实外部高水位后前移并保存；脚本要求大于备份内所有 users.recovery_epoch |
| VAPID | 首版未启用，**不适用**；存在非空 Push 绑定时本工具拒绝假装完成字段校验，须 P6 的真实加密格式接入后重测 |

CLI 的 `--master-file` 是原始字节，不是 Wrangler 注入用的 hex 文本；转换只能由所有者在私有环境做，禁止 shell 历史中写 secret、禁止 `set -x`。备份密钥与字段恢复材料须不同文件且不同于数据目录。根秘密是多个用途的恢复根，不能声称改根只影响字段加密。正常退订密钥轮换用已有 `CRYPTO_UNSUBSCRIBE_KEY_ID` / `CRYPTO_UNSUBSCRIBE_ACCEPTED_KEY_IDS`；旧链接仍要实际关闭当前邮件。灾难撤销移除旧 ID 时旧链接应明确 410。更换根涉及 email lookup、退订兼容等跨模块迁移，本卡不提供可部署根轮换。`rotateFields` 只证明离线逐字段重新加密/旧钥失败，不可单独部署其结果。

## 导出、加密与保存（所有者操作）

以下 `$BACKUP_*` 路径均由所有者设为仓库外私有目录，目录 0700、文件 0600，数据目录与密钥/epoch 目录分开，不能用工作树或 PR 附件存放。明文 SQL/恢复 SQL 属敏感数据，应放在所有者加密磁盘，完成后清除临时副本；普通删除不承诺 SSD 安全擦除。

1. 核对当前部署 commit、迁移和目标 D1 标识、已有权限与包含量；开启维护窗口，记录冻结点。不得为导出扩大权限。目标导出测试若未获可用权限，保留阻塞事实，仍可运行本地演练。
2. 在仓库 Worker 目录用锁定 Wrangler **由所有者**执行（本 Agent 未执行远端命令）：

```sh
umask 077
CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler d1 export "$BACKUP_DATABASE" --remote --output "$BACKUP_DATA/export.sql"
```

记录请求阻塞起止、失败/超时、导出字节数、迁移号与冻结点（不记录完整 URL/个人内容）。这是全量 schema+data 导出，不能只导事件表。

3. 回仓库根目录首次生成独立备份 key，随后加密/校验：

```sh
CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx scripts/backup/cli.mjs keygen --output "$BACKUP_KEYS/backup.key"
CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx scripts/backup/cli.mjs backup --input "$BACKUP_DATA/export.sql" --output "$BACKUP_DATA/generation.hbk" --key-file "$BACKUP_KEYS/backup.key" --master-file "$BACKUP_FIELDS/master.raw"
CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx scripts/backup/cli.mjs verify --input "$BACKUP_DATA/generation.hbk" --key-file "$BACKUP_KEYS/backup.key" --master-file "$BACKUP_FIELDS/master.raw"
CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx scripts/backup/cli.mjs retention --directory "$BACKUP_DATA" --key-file "$BACKUP_KEYS/backup.key"
```

文件名每代不同。包内 `capturedAt` 是本地加密校验时刻，实际 D1 一致性冻结点须另记，不以该时间推断 RPO。密文复制到独立介质后，再从介质读回 `verify`，核对包 SHA-256。只在新代恢复验证成功后按计划移除旧代。备份密钥轮换时旧包需旧钥；可离线解密后以新钥重新封装并双重验证，再销毁旧材料，不能只重命名 key 文件。

## 恢复顺序与放行门（严格顺序）

### 1. 隔离并关外发

先从负载入口摘除待恢复库，停旧执行器/在途请求，断开真实邮件、Push、模型、来源、Queue 消费和 DO 唤醒；核实不会有旧 isolate 对新库写回。不是只依赖导出里的布尔开关。所有者持有的 `current.json` 必须有 `isolated:true`、`outboundDetached:true`，并由操作者在当前事故冻结点确认。工具自身无网络、无平台绑定。即使输入备份旧开关为 true，输出所有 contracts 运行门关闭，`read_only=true`，每个来源门关闭。

### 2. 校验 Schema、密文、证据

用匹配备份迁移链的代码 `verify`。不同迁移版本先在原代码版本隔离解包，再受控应用缺失迁移并重新演练；不要编辑清单绕过校验，不执行回滚 DROP。密文认证、字段 AAD、Feed token/hash、正式证据 hash/引用、schema/索引和 SQLite 完整性均必须通过。非空 Push 当前拒绝，不能抹去数据来过检查。

### 3. 使用外部当前 epoch 废止旧认证

`current.json` 由所有者在与密文/密钥分开的当前控制记录中提供。形状如下（示意值不是生产材料）：

```json
{
  "isolated": true,
  "outboundDetached": true,
  "observedAt": 0,
  "freezeAt": 0,
  "epoch": 0,
  "revocationsComplete": false,
  "activeIdentities": [],
  "versionsComplete": false,
  "feedHighWater": []
}
```

不能原样使用零值：时间是当前事故冻结时的 UTC 毫秒，两时间相同且不早于备份、不晚于运行；epoch 必须来自独立当前记录并前移。可信“新近”由所有者证明清单覆盖直到停止全部写入的同一冻结点，**不是**随意填一个最近时间戳。工具不能自行证明来源可信，无法证明就保持两个 Complete 为 false。

```sh
CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx scripts/backup/cli.mjs restore --input "$BACKUP_DATA/generation.hbk" --output "$BACKUP_RESTORE/isolated.sql" --key-file "$BACKUP_KEYS/backup.key" --master-file "$BACKUP_FIELDS/master.raw" --current-file "$BACKUP_CURRENT/current.json"
```

脚本先校验、再事务前移全部用户恢复 epoch/auth_epoch；撤销 pending/active/管理员会话，清空认证回执和临时投递密文、终止旧挑战和最近认证证明，过期未完成恢复码轮换。恢复码消费未知时全部撤销旧码，不恢复为可用；这是灾备操作，**不是**改变日常紧急停用“不消费恢复码”的语义。生成后库保持离线，只能作为隔离恢复中间产物。

### 4. 对账撤销、版本与通知

无可信撤销清单：所有邮件席位与常规层关闭，Push 关闭，旧 Feed token 换成不可知随机值的 hash 并清空密文，旧恢复码不可用。不推断默认同意、不自动恢复任何发送。

`revocationsComplete=true` 时，`activeIdentities` 必须是冻结点全部可恢复活动身份的精确白名单，条目为 `{id,email_binding_id,email_version,email_key}`。仅标记“active”不够；邮箱变更、删除、安全停用、平台投诉/抑制、两层同意及其版本必须在独立清单复核。工具比较完整绑定，缺失/变更记为 `unresolvedAccounts`；不把未知状态伪造成删除或重新激活。只要计数非零，**整个恢复库仍不得开放登录、账号控制或认证发信**。所有者须从可信现状补齐这些账户的数据/终止事实，按已有生命周期语义处理，重新备份并重跑；无法取证时保持账号恢复未放行，公开读可先恢复。不可通过手改 Complete 或忽略报告放行。

`versionsComplete=true` 时，`feedHighWater` 条目 `{namespace,maxSequence}` 必须覆盖该 namespace 历史上所有曾发出的节点 SEQUENCE（包括备份后新建/变更/移除节点），来源是冻结前最新数据库及发布记录/可信导出。工具验证整数和安全上界，将 view_revision 抬到已证明最高 SEQUENCE 之上，保留 namespace/节点 UID 及三个业务版本，仍禁用 Feed 直到人工事实对账与快照重建完成。此前缺失的节点/更正不能因版本上升被当作正确数据；最新 event/schedule/public_ical 事实仍须从证据恢复，禁止盲目启用旧快照。

无高水位/覆盖不完整/值不可信：报告 `migrationRequired`，受影响 Feed 保持 disabled、全局 calendar_enabled 保持关闭。公开维护说明列出恢复影响；用户需在客户端移除旧订阅，在新的日历容器中重新订阅恢复后明确提供的新地址，并清理旧副本。保留现有 namespace，不绕过 immutable 触发器、不宣称透明无损回滚；客户端新容器的 UID/SEQUENCE 行为必须实测。迁移完成前不开放相关 Feed；这份说明不是已实现自动迁移 UI。不群发邮件要求重新确认。

历史通知保留去重族与 accepted 等事实；pending/retry_wait 转 skipped，leased/calling_provider 保留为 unknown 并提高租约版本；occurrences 全部 invalidated，旧发布 outbox 不重新 dispatch，未完成 jobs 标为 failed 并提高租约版本。预算 reserved/settled/uncertain 不退款；不能凭旧备份重建当日余额，发送恢复前必须对账当日账本，否则至少保持当日外发关闭直到新的 UTC 日并重新核实平台限额。accepted 不代表送达/已读。恢复后只创建事故后明确允许的新工作，禁止全量历史 backfill 当新通知发出。

DO 唤醒丢失：D1 是待办权威，先检查 failed/租约水位及关闭门，在隔离环境重新建立**经过审核的新任务**，调用现有 Cron/watchdog 验证补 alarm。不能把旧 DO storage/alarm 连同旧租约原样复活。旧执行器必须已停；只把 lease_version 加一不能代替摘除旧实例。

Queue/DLQ：先保持消费者断开，所有者记录现有 Queue/DLQ 的保留期限、积压和最后可信反馈点，逐条核对账户/订阅来源、eventId、messageId。只重放反馈，不将 DLQ 当业务发信队列。没有匹配 mail_outbox 的反馈继续待重试/人工核对，不按邮箱或主题猜关联；complaint/hard_bounce 优先恢复抑制，重复 eventId 不能重复结算预算。缺少可信最新抑制时继续关闭发送。现有本地反馈用例覆盖 retry/去重/原生 Queue 接线，平台 DLQ 实際转移/重驱仍需所有者证据。

### 5. 恢复公开读与账号控制

先验证隔离 SQL 在匹配 schema 的目标中导入；目标必须空库或已批准清理的隔离目标，不能把 INSERT 直接灌进在线原库。目标 D1 的导入只由所有者执行既有资源操作；本卡不创建恢复库。普通 SQLite 可用本工具导入验证，D1 用锁定 `wrangler d1 execute ... --file`，不添加 BEGIN/COMMIT（输出仅 defer_foreign_keys）。禁止为了演练另建收费资源。

核对正式事件证据、发布代次、更正层和完整快照缩水守卫，先恢复公共浏览；注明事实更新时间。开放账号控制前按现有容量注册项对账真实账号/会话/邮件席位存量与 capacity_state、admission_reservations；已撤销对象不再占有效名额，但不能把存量重算当作退回已消耗日预算。恢复工具保留旧账本供审计，不伪造当前配额。确认 `unresolvedAccounts=0`、可信撤销/身份/地址事实与恢复 epoch 已部署，再允许账号控制。保留注册/邮件新席位/常规层/业务/模型/Push/自动发布/回收关闭。新认证只在恢复链校验成功后单独开启认证所需门，旧凭证不得因此复活；完成用户自行重新登录与生成/确认新恢复码，不向整库群发重确认。Feed 另受上一步版本/迁移门约束。

### 6. 最后恢复发送

再次检查新的当前撤销/抑制、最新两层同意、地址版本、当日预算、发送状态去重、反馈/DLQ、租约与报警；由所有者按现有管理控制面逐项开门并保留脱敏证据。无可靠同意或撤销不能自动重新勾选邮件/Push。先在明确授权范围验证，不能因本卡通过发真实邮件。任何检查失败返回第 1 步隔离，保留失败产物，不恢复旧认证结果或旧发送队列。

## 演练与验收命令

```sh
CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx --test scripts/backup/backup.test.mjs
CI=1 WRANGLER_SEND_METRICS=false pnpm exec tsx scripts/backup/drill.mjs
CI=1 WRANGLER_SEND_METRICS=false pnpm --filter @hoyo/worker exec vitest run src/executors/pipeline/runtime.test.ts src/executors/delivery/runtime.test.ts src/mail/feedback/feedback.test.ts src/storage/crypto/unsubscribe.test.ts
```

专项脚本不在根 `pnpm test` 自动收集范围，须显式运行，不用根测试绿替代。本地 drill 实际启动公开 CLI 子进程，生成全迁移合成库→SQL→加密文件→校验→关闭门恢复 SQL→重新导入，并实际执行损坏密文/错钥/旧 epoch/输出覆盖拒绝。只提交脱敏 report，不提交原始库/SQL/密文/随机材料。恢复日后迁移变化必须在原分支 merge main 后重跑，不能拿旧演练结论代替兼容。

## 所有者目标环境证据模板

| 项 | 必填事实 | 本卡状态 |
| --- | --- | --- |
| 导出 | 时间、部署 commit/迁移、冻结区间、字节、请求阻塞/错误、耗时、包含量影响 | 未执行，需所有者 |
| 独立存放 | 介质/保管责任人、复制与读回校验时间、仅密文摘要、份数/下次截止 | 未执行，需所有者；不公开实际敏感路径 |
| 分离保管 | 字段、退订、备份解密、当前 epoch 分别已存；VAPID N/A | 未执行，需所有者，不填 secret |
| 当前安全事实 | 冻结点撤销/身份/抑制/码消费/版本高水位来源与覆盖，审核人 | 未执行，缺失按关闭门处理 |
| 恢复 | 隔离、校验、epoch、对账、公共读/账号控制、最后发送各阶段耗时/结论 | 本地合成已测；目标环境未执行 |
| 故障 | 实际 DO alarm 丢失与 watchdog、旧租约拒绝、真实 Queue DLQ 转移/重驱、密钥兼容 | 本地已有模拟/运行时证据；目标平台未执行 |

回退是撤回本卡脚本/手册到开工基线代码；代码回滚不等于数据库回滚。本工具不就地修改源 SQL、源库或已有备份，失败没有覆盖；已经执行的目标库操作必须按本手册重新隔离恢复，不能撤销 epoch 或消费状态。
