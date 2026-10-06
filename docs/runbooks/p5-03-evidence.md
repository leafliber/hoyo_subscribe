# P5-03 本地恢复证据（2026-10-03）

全部数据为 synthetic，全部平台执行为本地；远端导出阻塞、真实恢复耗时、实际存放/密钥保管、平台 DO/Queue/DLQ 操作均未执行，需所有者。没有真实邮件、Push、资源/权限/计划或业务代码改动。

基线 `origin/main=304af8b`（含 P5-01 `71f49a4`），独立分支 `p5/P5-03-backup-restore`。交付前再次 fetch：仍同基线，P5-02 #78 尚开放未合入，没有新的 schema/期限改动需要 merge；后续合入必须 merge main 重跑本演练。主工作区未切换/写入。

- [实际 CLI 演练记录](p5-03-drill.synthetic.json)：9 个子进程步骤均符合预期，成功与故意失败逐条保留退出码和实测本机毫秒。43 张应用表完整覆盖；有效字段密文 4 条、正式证据 1 条。恢复后 unresolvedAccounts=1、migrationRequired=1 如实阻止开放，不以合成演练通过代替生产放行。
- [标准验证与本地 D1 聚合结果](p5-03-checks.synthetic.json)：八命令顺序完成；build 外层 300 秒，4.55 秒 exit 0。contracts 269、Worker 1057、E2E 711 passed / 5 既有 skipped；参数 30/30，0001–0025 重放及 13 条迁移测试。
- 新专项 `scripts/backup/backup.test.mjs`：12/12；实际 CLI `scripts/backup/drill.mjs`：9 步。专项未自动纳入根 test，交付时显式跑过。
- 现有 workerd/D1/DO/反馈/退订专项：四文件 93/93。精确命令见操作手册；其中真实本地 DO watchdog 补丢失 alarm、旧租约 CAS、原生 Queue 消费接线/去重/错误 retry 和退订 key_id 轮换均由原有用例覆盖。平台实际 DLQ 搬运不在本地结果内。

## 本地 D1 格式往返

以下是本次实际执行命令，所有路径只含合成数据。临时 Wrangler 配置只声明合成 D1 占位 UUID 与项目同兼容日期，位于 `/private/tmp/p5-03-d1-engine/wrangler.json`；本地状态写同目录 `.wrangler`，不创建远端资源。每条命令均设 `CI=1 WRANGLER_SEND_METRICS=false`；Wrangler 另设 `WRANGLER_LOG_PATH=/private/tmp/p5-03-local-d1.log`。

```sh
pnpm --filter @hoyo/worker exec wrangler d1 execute DB --local --config /private/tmp/p5-03-d1-engine/wrangler.json --file /var/folders/vr/xq2gyj_j1w5f2rbw5h06rtqw0000gn/T/hoyo-p5-03-synthetic-InHARV/restore/isolated.sql
pnpm --filter @hoyo/worker exec wrangler d1 export DB --local --config /private/tmp/p5-03-d1-engine/wrangler.json --output /private/tmp/p5-03-roundtrip.sql
pnpm exec tsx scripts/backup/cli.mjs backup --input /private/tmp/p5-03-roundtrip.sql --output /private/tmp/p5-03-roundtrip.hbk --key-file /var/folders/vr/xq2gyj_j1w5f2rbw5h06rtqw0000gn/T/hoyo-p5-03-synthetic-InHARV/backup-keys/backup.key --master-file /var/folders/vr/xq2gyj_j1w5f2rbw5h06rtqw0000gn/T/hoyo-p5-03-synthetic-InHARV/field-keys/master.key
pnpm exec tsx scripts/backup/cli.mjs verify --input /private/tmp/p5-03-roundtrip.hbk --key-file /var/folders/vr/xq2gyj_j1w5f2rbw5h06rtqw0000gn/T/hoyo-p5-03-synthetic-InHARV/backup-keys/backup.key --master-file /var/folders/vr/xq2gyj_j1w5f2rbw5h06rtqw0000gn/T/hoyo-p5-03-synthetic-InHARV/field-keys/master.key
```

全部 exit 0；重封装校验结果 43 tables / 1 ciphertext / 1 evidence（认证/Feed 密文已按恢复撤销，只留合法投递地址密文）。随后在同一 D1 实跑聚合查询和 `PRAGMA foreign_key_check`：active_sessions=0、enabled_mail=0、enabled_feeds=0、usable_old_codes=0、evidence_rows=1，外键检查空结果。不是仅以 SQL 文本推断关闭。

复现时先运行 drill，使用其新临时目录，不依赖这台机器保留的目录。原始 SQL、数据库、加密包、随机 key/current 文件不提交；已提交 JSON 只有计数、摘要、时间与脱敏结果。完整原始测试日志仅保留本机 `/private/tmp/p5-03-checks/`、`/private/tmp/p5-03-runtime-tests.log`，无生产数据。

## 失败记录

开发初跑专项：第一次因合成 key_id 不符合既有格式失败（0 通过）；随后夹具遗漏 sources.cursor_json、events.status 使用非合同枚举，分别 1 passed / 9 failed，补正夹具后 10/10，补充删除墓碑/证据丢失用例后最终 12/12。未改业务约束或放宽测试。

额外本地 D1 导出初次使用 `--persist-to`，锁定 Wrangler 报 `Unknown arguments: persist-to, persistTo`，exit 1；独立临时 `--config` 路径修正后导入/导出及重新加密验证全过。初次 `git fetch` 在沙箱因 FETCH_HEAD 只读失败，获准 Git 元数据操作后 fetch 成功。GitHub CLI 首次受网络沙箱限制无法连 api.github.com，获准只读查询后成功。没有把失败写成通过。

损坏密文、错误备份 key、旧 epoch、已有输出文件的 CLI exit 1 是刻意构造的成功拒绝证据；旧 epoch 未产生输出，覆盖尝试没有改变已有文件摘要。任何真实恢复仍须按手册顺序核实独立当前撤销事实后才逐门放行。

**后续（2026-10-06 文档整理）**：本证据基于 0001–0025（43 张应用表）。之后合入 0026（索引）、0027、0028，应用表为 47 张；工具按迁移目录动态枚举，无需改动。0026 的联合演练见 P5-03 卡末登记；0027/0028 之后没有重跑记录，按手册须在下次带迁移的发布前补跑。
