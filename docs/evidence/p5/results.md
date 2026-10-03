# P5-04 本地交付证据与放行缺口

2026-10-03；synthetic，E1/E2。代码基线 efb320e；前置 P5-02 #78/13ddad2、P5-03 #79/68d0f41、P5-05/3b8c643 均已合入；开工无同卡分支/PR。独立工作树 p5-04-release-readiness，分支 p5/P5-04-release-readiness。首次提交 af773b3 只登记场景、来源、参数、边界及缺证据项；之后 merge origin/main 至 d54891e（含 F3-04 #76），未 rebase。最终代码 dcd3381；随后仅增加本报告和脱敏证据。没有迁移（main 最大0026）、参数、生产开关、路由或验收方文档变更。

**最终上线未放行。**缺平台 E3 和正式前端全链；本地两次 build 超时均为失败，不写成八命令全绿。未操作 Cloudflare、真实发信或清理生产数据。所有者部署正式站点 https://hoyo.airo.cc；具体配置、关门、取证与停止步骤见 [owner-handoff.md](owner-handoff.md)。

## 环境、边界与实测

macOS 本机，Node v26.8.1、pnpm 11.11.0，仓库锁定 workerd/Wrangler/Chromium；统一 CI=1 WRANGLER_SEND_METRICS=false，原始日志在源码外 /tmp/p504-*。负载时间 2026-10-03T08:59:16.838Z。单个真实本地 Worker + 本轮构建 assets，隔离 D1、两个原固定 DO 绑定；测试 wrapper 只做随机 loopback 端口的合成播种、计量和断言，无远端入口。源码外临时数据库与配置退出清理，真实 provider 绑定、Cron、Queue 消费者不接入。本地假 provider 走生产 outbox/账本，真实发送0。官方站点抓取未执行。

下列 count 是场景操作次数，组合场景含多个 HTTP/函数调用；concurrency 是合成负载形状，不是新增运行阈值。p50/p95 为端到端 wall 毫秒；一次样本不是可靠分位数，更不是平台计费 CPU。cold 通过清空公共壳缓存与 FeedPublicCache 模拟冷缓存，不是冷启动 isolate。只报告事实，不设未经裁定的性能 SLO、不按本机吞吐外推生产容量。查询/读写是观测器捕获的实际本地 D1 返回统计，播种与结果证明查询在计量之外；索引/触发器写入不等于业务修改条数。

| 场景 | 次数/并发 | p50/p95 ms | D1 查询 | rows_read/rows_written |
| --- | --- | --- | --- | --- |
| static-assets | 12/4 | 4.29/5.82 | 0 | 0/0 |
| public-cold | 1/1 | 58.19/58.19 | 4 | 1006/0 |
| public-warm | 12/4 | 94.42/103.57 | 24 | 60/0 |
| public-status | 8/2 | 5.36/7.87 | 56 | 224/0 |
| authorized-feed-cold | 1/1 | 108.44/108.44 | 7 | 1021/6 |
| authorized-feed-warm | 8/2 | 188.02/204.35 | 40 | 144/8 |
| authorized-head | 8/2 | 185.64/196.07 | 40 | 144/8 |
| authorized-304 | 8/2 | 192.94/197.73 | 40 | 144/8 |
| private-preview-complete | 1/1 | 220.01/220.01 | 10 | 18/0 |
| revoked-hot-feed-and-session | 1/1 | 12.62/12.62 | 7 | 14/0 |
| local-fake-provider | 12/1 | 6.63/9.42 | 288 | 560/494 |
| full-capacity-manual-reclaim | 1/1 | 76.19/76.19 | 217 | 1788/58 |
| full-feedback-rounds-shared-reclaim | 1/1 | 178.46/178.46 | 1000 | 1707/928 |

- 授权 Feed/HEAD/304 使用同一实际生产授权与完整快照路径；热缓存撤销后 Feed 明确404、私人会话拒绝，不把缓存命中当授权。
- 私人预览样本两页1000项完整；仅此样本，不代表极大 blocked 集合一定取全。ADR-0008 的11341项反例本轮未另造重跑；继承既有验收结论，在帮助/状态中公开受限和缩小已保存范围指引。新增页面测试不替代 F3-04/F3-05 全链。
- 假外发12次：accepted4、unknown4、可重试明确拒绝4；生产账本 settled8（包含拒绝）、uncertain4，不自动重发、不退未知占用、不把accepted当送达。日池/floor/跨日/预留清理等由下面180项实际生产依赖回归覆盖。
- 满容量500账号、100邮件席位、40常规资格；扫描500后仍需人工确认，暂停时拒绝，Feed-only 活动自动续租；显式确认并清理后499账号/99席位、账本不变。wrapper 调生产函数不冒充管理员浏览器流程；路由鉴权/CSRF/CAS由 routes.test.ts 专项覆盖。
- 四轮反馈与回收在同一个实际维护调用共享预算，反馈729 + 回收271 =1000；观测器总数也为1000，40条反馈完成，1条仍unknown。预算被用满，没有证明生产余量；本轮未提高上限。

## 日池和平台对账

[reconcile.synthetic.json](reconcile.synthetic.json) 是人工合成输入，[reconcile.result.synthetic.json](reconcile.result.synthetic.json) 是工具实际输出。2026-10-03/04 日期是测试跨UTC日，不是未来已发生的账单。四用途账本合为认证/基础业务/紧急业务三个UTC日池；保留settled/reserved/uncertain、已知接受/拒绝、未解释settled、跨日流向；注册子池和floor由contracts计算。unknown不变零，不能据理论余量承诺账户零超额。平台账户、其他应用、本应用分别输入，同窗口同单位对账；保留超包含量和归因差额，不内置猜测费率。synthetic=false也只标owner_supplied_unverified，不自行授予E3或放行。

| 外部事实 | 本轮结果 |
| --- | --- |
| Workers请求/目标计费CPU/包含量/实际账单 | 未执行/未知，需所有者提供 |
| D1目标读写/存储/容量/事务行为 | 未执行/未知，需所有者提供；本地读写不能替代 |
| DO目标请求/时长/存储/alarm与发送位置 | 未执行/未知，需所有者提供 |
| Queue目标操作/重试/DLQ/唯一消费者 | 未执行/未知，需所有者提供 |
| 邮件真实接受/时延/反馈/账户其他占用/两退订头签名覆盖 | 未执行/未知，需所有者提供 |
| 独立介质实际到位/密钥与当前epoch分离/目标导出阻塞与恢复耗时 | 未执行/未知，需所有者提供；本地演练不是此项通过 |
| 正式站点首次保存到客户端全链、其他客户端兼容性 | 未执行/未知，需所有者提供并完成前端验收 |

## 顺序八命令的真实结果

两轮均按下表顺序完整执行；pnpm build 外层300秒终止进程组（124）。第一轮 cfa3a98，第二轮 dcd3381。命令结果原始结构见 [commands.json](commands.json)。

| 命令 | 首轮exit | 最终exit | 最终秒数 |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 0 | 0.189 |
| `pnpm lint` | 1 | 0 | 0.45 |
| `pnpm typecheck` | 0 | 0 | 0.976 |
| `pnpm params:verify` | 0 | 0 | 0.307 |
| `pnpm migrate:check` | 0 | 0 | 3.273 |
| `pnpm test` | 0 | 0 | 26.499 |
| `pnpm build` | 124 | 124 | 300.038 |
| `pnpm test:e2e` | 0 | 0 | 135.624 |

首轮lint失败是本卡导入排序/格式，已修复；最终lint仅一条继承自main的preview.test.ts信息，不扩改。params均32/32，迁移均0001–0026/schema15；首轮contracts276/Worker1085/E2E723通过，最终contracts278/Worker1086/E2E783通过；E2E两轮均5项既有视口跳过，未新增skip。build两轮网页与Worker dry-run均产出且打印退出提示，但整个命令未在300秒内正常结束，**仍是失败**。站点冒烟使用最终轮生成产物；后续CI需独立确认，不改写本地历史。

## 显式专项与承重变异

| 命令/测试文件 | 实际结果 |
| --- | --- |
| `node scripts/site/smoke.mjs` | exit0，A-P5-SITE 23/23；静态Worker调用0，动态/未知8；无效退订503是拒绝，不是成功 |
| `pnpm exec tsx --test scripts/backup/backup.test.mjs` | exit0，12/12；开工和最终各一次 |
| `pnpm exec tsx scripts/backup/drill.mjs` | exit0，9步实际本地CLI演练；开工和最终各一次；targetEnvironment=not executed |
| `pnpm exec tsx --test scripts/load/reconcile.test.mjs scripts/load/cli.test.mjs` | exit0，9/9；unknown、跨日、其他占用、floor、strict input、CLI拒绝远端/泄漏 |
| `pnpm exec tsc -p scripts/load/tsconfig.json` | exit0 |
| `pnpm exec tsx scripts/load/run.mjs` | exit0，以上13组实际本地场景 |
| `node scripts/load/regression.mjs` | exit0，9个既有workerd文件180/180：preauth/admission、ledger、budget、outbox、reclaim、reclaim/routes、reclaim/combined、preview/rate、mail/channel |
| `pnpm exec tsx scripts/load/reconcile.mjs docs/evidence/p5/reconcile.synthetic.json` | exit0；平台所有项null，finalRelease=not_decided |
| `pnpm exec tsx scripts/load/policy.mjs` | exit0；只读输出当前contracts参数和关闭门目标，不执行写入 |
| `pnpm exec playwright test tests/e2e/a11y.spec.ts tests/e2e/release.spec.ts` | 恢复后33通过/5既有跳过；其中release12、U28通过21；最终又被全量覆盖 |

三条变异在干净a6af0b2上执行：对账遗漏uncertain、contracts占用遗漏uncertain、页面把unknown写成已开放。每条先断言替换恰1次、git diff非空、临时探针留源码外；三条各自测试exit1检出。每条逐字节还原且git status干净；还原后工具9/9、网页重建成功、两页面专项33/5。随后仅时间展示改用既有UTC+8 helper并执行最终整轮。详见 [mutations.json](mutations.json)。contracts仅临时变异，提交中没有contracts更改。

保留的探索失败：首次负载错误期待撤销Feed410、实际404（按既有协议修正断言）；首次TS配置相对types路径导致TS2688（改为node）；首次页面夹具使用不存在的starrail枚举导致双视口两项失败（改为hsr）。初次共享计量把两条证明查询混入得到1002，已把证明查询移出计量请求；最终生产维护观测1000，未改预算。不是把这些失败追溯写成通过。开工沙箱git fetch写FETCH_HEAD及网络gh失败后，在授权隔离工作路径/网络执行重试成功。

## 页面证据、范围和回退

[help桌面](release-help-desktop.png)、[help手机](release-help-mobile.png)、[status桌面](release-status-desktop.png)、[status手机](release-status-mobile.png) 是最终本地Chromium实际截图（2026-10-03）；status API为明确synthetic夹具，不能代表正式站点当前状态。已检查无横向溢出、未知不正常化、页面不再是组件演示。U28演示只在测试服务的精确/__test/p5-release路径，产物检查确认不进入dist；_redirects未更改。

所有变更在用户批准范围。无新运行参数/依赖/迁移；不改相邻业务、生产开关、验收方维护文档。没有真实云压测/发信/上线/清理、额外费用授权、模型或Push实现。禁止清单相关业务实现未改变；对账只用现有三个日池公式。源码回退基线efb320e，当前合并基线d54891e；实际撤销本卡可revert本卡提交或回退到此前已验证部署，不能倒退数据库、恢复epoch、已消费预算、UID/SEQUENCE。独立备份与目标恢复按既有runbook由所有者执行。
