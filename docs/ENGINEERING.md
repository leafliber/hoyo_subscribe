# 工程约定

> 依据：主方案 §2.1、§8.3、§10.5；前端 v1.0 §12。
> 本文件规定**怎么做**，不规定业务含义。业务含义永远回到两份合同文档。

## 1. 仓库结构

单仓库、单 Worker 部署单元。下列目录是职责划分，**不是部署服务划分**（主方案 §10.5）。

```text
/
├── AGENTS.md                  执行者入口
├── docs/                      合同、执行层文档、任务卡、ADR
├── apps/
│   ├── web/                   Astro 静态站点 + 小型 TS 模块（目录与设计系统约定见 apps/web/README.md）
│   │   └── src/
│   │       ├── pages/         路由、静态骨架、按需加载入口（含 admin/ 三页：审核、版本时间表、运行开关）
│   │       ├── components/    表单字段、图标、游戏标识、折叠、对话框、状态提示等基础组件
│   │       ├── features/
│   │       │   ├── schedule/      公共筛选、时间轴、详情、公告原文弹窗、数据状态
│   │       │   ├── subscription/  草稿、已保存快照、差异、预览、保存状态机
│   │       │   ├── auth/          预认证、OTP、会话激活、恢复流程、账号页
│   │       │   ├── channels/      日历、邮件、浏览器通知（Push，ADR-0025）的状态与操作
│   │       │   ├── admin/         管理端：审核与 AI 草稿、版本时间表、运行开关
│   │       │   └── info/          帮助与状态页样式
│   │       ├── lib/           公共 API 访问、错误映射、按账号本机存储、安全 DOM 构建与格式化
│   │       └── styles/        设计 token、组件库样式、对比度登记、退订页样式
│   └── worker/                唯一 Worker 项目（原生 fetch handler）
│       └── src/
│           ├── shell/         API 外壳：路由、错误、Origin/CSRF、请求体校验、日志；observability/ 观测与运行开关
│           ├── auth/          预认证、OTP、会话、恢复码、最近认证
│           ├── accounts/      用户、准入、订阅配置、活动水位、换邮箱/删除/导出、回收
│           ├── admin/         管理员会话、审核 API、版本时间表、审计
│           ├── public/        公共读 API：目录、日程、详情、状态、公告原文
│           ├── sources/       来源注册、适配器、采集与游标、文章版本
│           ├── extraction/    规则 / 人工两路与候选审核；model/ 为 AI 草稿与「跳过审核」（模型抽取路径 P3-09 未做）
│           ├── publishing/    原子发布、三类版本、outbox
│           ├── calendar/      公共快照、更正层、个人 ICS 组装、缩水守卫、预览、Feed 管理
│           ├── mail/          发生项、调度、outbox、预算、通道、退订、反馈（含 Queue 消费）、抑制
│           ├── push/          可选 Web Push：绑定与 receipt、VAPID 与 RFC 8291 加密、业务展开与外发（ADR-0025）
│           ├── executors/     PipelineDO / DeliveryDO 两个固定 DO 与执行器核心
│           ├── scheduled/     Cron 入口与定时维护：清理、反馈、回收
│           └── storage/       D1 访问层、条件提交原语、账本、字段加密
├── packages/
│   └── contracts/             枚举、Schema、参数注册表、规范化纯函数（Worker 与 Web 共用）
├── migrations/                D1 迁移，顺序编号，只进不退
├── fixtures/                  样例数据；合成样本必须带 synthetic 标记
├── tests/                     跨包的集成与纵向闭环测试
└── scripts/                   探针、采集、负载与对账、备份恢复、迁移与参数校验、站点冒烟、e2e 服务
```

**禁止**：在 `apps/web` 里引入任何秘密或服务端专用依赖；在 `apps/worker` 各子目录之间建立循环依赖；为单个组件建立独立全局状态；把业务规则写进页面脚本而不是 `packages/contracts`。

## 2. 工具链

| 项 | 选择 | 说明 |
| --- | --- | --- |
| 包管理 | pnpm workspace | 锁文件提交，`packageManager` 字段固定版本 |
| Node | 以 `.nvmrc` 固定版本 | 当前 `.nvmrc` 为 26.8.1；pnpm 由根 `package.json` 的 `packageManager` 固定为 11.11.0 |
| 语言 | TypeScript，`strict: true`，禁用隐式 any | 不使用 `any` 逃逸；确需断言时写理由注释 |
| 后端框架 | **不引入 Web 框架**：原生 `fetch` handler + 自建中间件 | 单 Worker，路由按 §1 的子目录挂载；外壳与中间件由 P1-08 交付，P2 起按 `ShellRoute` 挂载 |
| 前端 | Astro 静态输出 + 原生 TS 模块 | 不引入大型前端运行时框架 |
| 校验 | Zod | 类型与运行时校验同源；版本在各包 `package.json` 固定（当前 4.6.5） |
| 测试 | Vitest + `@cloudflare/vitest-pool-workers` | Worker 测试跑在真实 workerd + miniflare D1/DO 上 |
| 端到端（前端） | Playwright | 仅 F 轮使用；截图作为交付证据 |
| Lint/Format | Biome | 单一配置，CI 强制 |
| 部署 | Wrangler | `compatibility_date` 与 Wrangler 版本一起固定，不随手升级（当前 Wrangler 4.136.0、`compatibility_date` 2026-08-01） |

> **为什么不用 Hono**（主方案 §2.1 原文是「API **可用** Hono」，许可而非强制，故无需 ADR）：
> 本项目的请求管线有两处框架中间件模型不好表达的硬要求。
> 一是 §4.2 规定了**严格且不可重排的检查顺序**（请求结构与尺寸 → 同源/CSRF → 限速 →
> Turnstile → 配额 → 原子预占 → 创建挑战），顺序本身是安全属性，需要精确控制而不是
> 交给框架的洋葱模型。二是 `/feeds/u/{token}.ics` 必须**豁免 Cookie 与 CSRF**
> 却仍受协议校验与限速（§8.3：个人 Feed 不得放到交互登录墙后），
> 这类例外在框架路由里最容易写错。
> P1-08 因此交付了框架无关的中间件；少一个依赖，也少一层版本升级面。

版本升级属于独立任务卡，不夹带在功能卡里。

## 3. 标准命令

P1-01 必须让下列命令全部可用，后续任务卡的交付报告直接引用它们：

```bash
pnpm install --frozen-lockfile
pnpm lint          # Biome 检查
pnpm typecheck     # tsc --noEmit，全 workspace
pnpm test          # 全部单测与 Worker 集成测试
pnpm test:contracts  # packages/contracts 纯函数
pnpm test:worker     # Worker 集成（含 D1/DO）
pnpm test:e2e        # Playwright，F 轮
pnpm migrate:check   # 迁移可重放性与索引检查
pnpm params:verify   # 附录 A.5 等式校验，等式不成立时非零退出
pnpm build
```

**本机 `pnpm build` 不退出的已知现象（2026-09-28 登记）**：Worker 的 Wrangler dry-run 打印 `--dry-run: exiting now` 后，
进程可能很久不退出（沙箱无网络时尤甚）；沙箱里还会因写默认日志目录报 `EPERM`。下面的写法能消掉日志 `EPERM`：

```bash
CI=1 WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/<卡号>-wrangler.log pnpm build
```

它**不保证**进程立刻退出：P2-04、P3-03 用它拿到了干净退出码，P2-06 等了几分钟后自行退出 0，F1-03 等约 90 秒仍未退出。
**等满 5 分钟**仍不退出就如实写进报告，以 PR CI 的 build 结果为准；**不要把手动中断当成构建成功**。

**2026-10-04 定因**（P3-19 时）：挂住的是 Wrangler 横幅检查新版本时开的 HTTPS 连接——本机代理把它挂住，`WRANGLER_SEND_METRICS=false` 管不到这个连接。加 `WRANGLER_HIDE_BANNER=true` 后 Worker 构建约 1 秒退出、完整构建约 2 秒。本机跑 `pnpm build`、`pnpm test:e2e`、wrangler 试运行与部署时统一带上：

```bash
CI=1 WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true pnpm build
```

交付报告如实写明用了这个环境变量。CI 不受影响。

## 4. 参数与配置

- **唯一来源**：`packages/contracts/src/params/` 导出附录 A 的全部参数。运行参数、文档表格、前端文案里的数值全部从这里取。
- **命名**：与附录 A 完全一致的全大写名（`SESSION_IDLE_TTL`、`MAIL_URGENT_FLOOR`…）。不得用斜杠缩写、不得改名、不得在消费方另起别名。
- **启动校验**：`pnpm params:verify` 与 Worker 启动路径都执行附录 A.5 的依赖等式；任一不成立**拒绝启动**并打印不成立的那一条。
- **P0 待定项**：`MODEL_MAX_INPUT`、`MODEL_MAX_BILLED_OUTPUT` 仍未填写，`AI_BILLING_PROFILE_CONFIGURED` 为 false，模型抽取路径（P3-09）**默认关闭**，不得用猜测值开启；`SOURCE_LIMIT_PROFILE` 已由 P0-02 填写。AI 草稿（ADR-0009/0010）用独立的 `AI_DRAFT_PROFILE` 与按其算出的 `AI_DRAFT_RESERVATION`，不依赖也不翻转上面两项。
- **秘密**：全部经 Wrangler secret 注入；仓库、前端产物、fixtures、日志、错误上下文中一律不出现。部署配置需记录 origin、资源绑定、发件域与实际平台权限（含 `PLATFORM_MAIL_DAY_LIMIT` 实测值）。

## 4.1 成本护栏：不得超出 Workers Paid 套餐

所有者已确认具备 Workers Paid 资格，并给出**硬约束：尽可能不产生套餐之外的额外费用**。
这不是优化目标，是与附录 A 等式同级的运行约束。

| 计量项 | 附录 A 的上限 | 落地要求 |
| --- | --- | --- |
| 邮件 | `MAIL_TOTAL_DAY = 260` | 平台侧唯一硬约束是**日上限**（实测 `PLATFORM_MAIL_DAY_LIMIT = 1,000`，无周期包含量、零其他占用）。须 `MAIL_TOTAL_DAY <= PLATFORM_MAIL_DAY_LIMIT`，当前成立（占 26%）。**已无月度维度**——纯日额度模型见 ADR-0003 |
| 模型 | `AI_SOFT_DAY = 6,000` / `AI_HARD_DAY = 8,000` Neurons | 每日免费额度 `AI_INCLUDED_DAY = 10,000` 为账户共用，等式 `ai-hard-within-included` 保证硬线低于它。AI 草稿（P3-17 起）调用前按本次输入预占、日累计以 `AI_SOFT_DAY` 为上限；同账户其他应用每日须少于 4,000 才能保证零额外费用（DEPLOYMENT_PREREQUISITES §2）。模型抽取路径（P3-09）未做 |
| 日志 | 无附录参数 | Workers Logs（ADR-0024，2026-10-06 起开启）：Workers Paid 每月含 2,000 万条日志事件；2026-12-01 起改按写入与存储字节计价（每个账单周期含 50 GB 写入、10 GB-月存储）。本站调用量远低于包含量 |
| D1 / DO / Queue | 无附录参数 | P5-01 的用量指标必须能看出是否逼近包含量；接近即告警并停止低价值扩大。ADR-0015 起公开读取为 `no-cache`，读库次数随访问量增加 |

三条规则：

1. **任何"提高上限"的改动都不算优化。**预算不够时正确做法是缩小开放名额或降低能力（§9.1
   "扩大邮件名额必须同时通过月预算、日平滑、平台动态限额和投递质量检查，不能只改 seats 数"；月预算已按 ADR-0003 改为日额度）。
2. **不新增计量项。**不引入 R2、Hyperdrive、向量库或任何附录 A 未覆盖的收费产品；确需新增写 ADR。
3. **开发与测试不烧生产额度。**Worker 测试跑本地 miniflare；测试里的模型调用一律用固定响应替身、零真实推理请求，
   真实调用只在所有者批准的取证里做（如 P3-17 的 6 次调用，见 `docs/evidence/p3/ai-draft-probe.md`）；仓库 `wrangler.jsonc`
   不声明 `AI` 绑定（声明会让 vitest 启动远程代理）；探针禁止 `wrangler deploy`，取证用 `wrangler dev` 临时运行后立即停止。

账单告警只是监控，**不是平台收费的绝对封顶**（§10.1）。真正的封顶是账本 + 开关。

## 5. 代码约定

### 5.1 时间

- 精确时间：UTC 毫秒整数。纯日期：`YYYY-MM-DD` 字符串。**两者不得互转**，只有日期不补午夜。
- 每个时间值同时保存 `source_timezone`、`raw_expression`、`time_basis`（`official_explicit / deterministic_derived / official_estimate / unresolved`）与 `precision`（`datetime / date / unknown`）。
- 日桶按固定 UTC 日计算。**邮件预算无月度维度**——每个 UTC 日独立、不跨日结转（ADR-0003）。
- 前端统一展示北京时间 UTC+8 并标明；展示时区切换不改变源事实与提前量。
- 官方时间写法的解析、版本锚点推导（`deriveVersionTime`，ADR-0011）与没写年份的补全（`completeYear`，ADR-0013）只在 `packages/contracts` 定义；Worker、审核页与公开详情都调用它们，不另写一套。

### 5.2 版本量

三个业务版本量互不替代，禁止合并成一个计数器：

| 量 | 何时增加 |
| --- | --- |
| `event_revision` | 事件任何修订 |
| `schedule_revision` | 仅时刻或提醒语义变化 |
| `public_ical_revision` | 影响该节点日历表现的变更 |
| `view_revision`（Feed 级） | 仅影响 ICS 的用户设置变化 |

`SEQUENCE = public_ical_revision(milestone) + view_revision(feed)`，两者均单调不减。普通读取不取号。

### 5.3 错误模型

对外错误至少区分：`validation`、`unauthorized`、`conflict`、`rate_limited`、`capacity_reached`、`quota_paused`、`temporarily_unavailable`。认证存在性敏感的结果一律折叠为统一响应，不得通过错误文案泄露某邮箱是否注册。

**折叠不只看第一次响应**（2026-09-29，P2-07 验收发现，见 P2-09）：同一邮箱的后续请求——冷却、当日次数、重发、错码校验——也不能分出已注册与未注册。
配额要按"受理的意图"计，不能按"实际发出的信"或"建了的挑战"计：关闭注册时未知邮箱不发信，按发信计数，第二次申请就只对已注册邮箱回 429。
近似限速门按 isolate 各记各的，挡不住换 isolate 的请求，不能当折叠的依据。测试时把近似门换成全放行替身，模拟请求落到另一个 isolate。

错误对象形状在 `packages/contracts` 定义一次，Worker 与前端共用；前端按 `docs/HOYO_SUBSCRIPTION_FRONTEND_DESIGN_v1.0.md` §11.3 映射到用户可执行的下一步。

### 5.4 数据访问

- 容量与并发一律走条件提交：**禁止 `COUNT` 后无条件 `INSERT`**。账号注册、验证码消费、会话激活、配置 CAS、Feed 换 token、退订、名额释放都必须在同一条件边界内完成。
- D1 `batch` 的 SQL 失败回滚**不等于** CAS 更新零行会自动失败；必须用统一条件守卫或约束让整批写入一起成立或一起失败，并为"数据库报错"与"条件未命中"分别写测试。
- `conditionalCommit`（`apps/worker/src/storage/cas.ts`）的依赖效果靠 `changes() = 1` 串链：前一条恰好改 1 行，后一条才执行。所以**除最后一条外，每条效果都必须恰好命中 1 行**（多行 insert 只能放最后），最后一条至少 1 行；守卫命中而效果不满足时，整批已经落库，调用方却收到 `CasInvariantError`。可能零行的写入——按 user_id 撤销"全部会话"、给可能还不存在的 Feed 行递增版本——不能直接写成效果：改用必然命中的守卫（如递增 `users.auth_epoch`），或先扩展原语再用（2026-09-28 验收登记）。
- **D1 的语句上限（2026-09-29 验收登记）**：单条语句最多 **100 个绑定参数**（本地 D1 同样执行，报 `too many SQL variables`）；
  每次 Worker 调用最多 **1,000 条查询**，`batch` 里的语句逐条计。所以守卫与效果的参数个数**不能随数据量增长**——需要核对一组行时，
  把它们打包成一个 JSON 参数用 `json_each(?)` 核对；一次调用要写的行数也要有上界，写不完就分批推进（进度落库）。
  P3-04 的发布守卫就栽在这里（见 P3-12）。只用"一两个事件"的小样本测不出来，用例要覆盖合同允许的最大形状。
- **D1 的单值上限（2026-09-30 验收登记，见 P3-06）**：单个字符串、BLOB 或行最多 **2,000,000 字节**，绑定的 JSON 参数同样算
  （超了报 `SQLITE_TOOBIG`）。上一条"打包成一个 JSON 参数"只解决参数个数；数据量会增长时，参数要**按字节分块**，
  报告写明语句数随总字节数的上界。本地 D1 的实际限值略宽（2.1 MB 能过、2.45 MB 失败），所以用例要用接近真实尺寸的数据，
  并有一条总量超过 2 MB 的。P3-06 的快照整代写入用 1 KB 的合成节点测，真实尺寸（约 2.5 KB）下 1,000 个节点就失败。
- 索引至少覆盖：邮箱键、token hash、所有者、endpoint hash、任务到期、发送状态/优先级、反馈 ID、清理时间、分页 order。测量真实 `rows_read`，不假定位图过滤会命中普通索引。
- **热路径不要对整表做 `UNION ALL` 再过滤（2026-09-29 验收登记，见 P2-09）**：公共表达式（`WITH`）被引用多次时 SQLite 会整表物化，
  外层的 `WHERE email_key = ?` 用不上索引。P2-09 的配额快照就这样写：塞入 2000 条历史行后 `rows_read` 从 17 涨到 14,010。
  跨表计数要在每个子查询里各自按索引列过滤再相加；新增热路径一律进 `storage/schema.test.ts` 的 rows_read 基准，
  并用"塞入大量无关历史行后读数不涨"的用例钉住。另外，只增不删的表要写明保留规则与清理原语。

### 5.5 日志与遥测

- 结构化日志，字段走**白名单**。Cookie、OTP、恢复码、完整邮箱、Feed/退订 URL、Push endpoint 与密钥永远不出现在日志、遥测、错误上下文与截图中。
- 异常请求日志采样，不为每次攻击生成一条持久审计记录。
- **平台调用日志**（2026-10-06 起，ADR-0024）：Workers Logs 的调用日志由平台写，记下每次调用的完整请求 URL 与请求元数据，不经本节的白名单；个人 Feed 与退订路径里的 token 会因此进入 Workers Logs（保留 7 天）。代码自己的日志仍按白名单。改动 observability 配置时，仓库 `apps/worker/wrangler.jsonc` 与源码外的正式部署配置要一起改。
- 每个运行开关与关键指标在实现时同步登记（见 `docs/tasks/P5-P6.md` 的指标表），不留到 P5 补。

### 5.6 定时任务与执行器（2026-09-29 验收登记，见 P3-11）

- **回收与清理要追得上产出。**每个周期在墙钟上限（`EXECUTOR_BATCH_WALL_LIMIT`）内循环到做完，而不是固定做一页；
  交付报告写明最坏情况下每天能处理多少、会不会积压。快照每次构建复制整代节点，一个周期只删 20 个节点远远跟不上。
- **失败要分级。**确定性错误（D1 绑定参数或语句数上限、数据形状不合法）停在 `failed` 并告警；其余失败在**下一个** watchdog 周期重试
  （不在同一批次里反复重试），每次记原因和次数并告警。不能让一次临时的 D1 错误把一个来源或一条通知信号永久停掉。
  **停的是出错的那个单元**（一个来源、一条信号、一封信、一个发生项），不是整个执行器：业务通知阶段的错误不能停掉认证发信
  （2026-09-30 验收登记，见 P4-03）。执行器确需整体停下时，对外的可用状态与生成前闸门要同步关闭——
  主方案 §2.3 要求发送不可用时"不先生成即将过期的验证码"并公开提示。
- 同一 DO 内串行执行；租约和进度写回都要带条件（`lease_version`），旧租约不能覆盖新进度。
- **等人工的待办要停放，不要每个周期重抽**（2026-10-04 #90）：发布待办遇到待审候选时停在 `awaiting_review`，watchdog 只在关联候选有新裁定时放回；
  否则待审积压会持续消耗 DO 请求与 D1 查询。周期性维护（清理、旧代回收）共用 `RECLAIM_QUERY_BUDGET` 硬预算，用尽按有界推迟降级并告警。
- **HTTP 请求不等 DO 的串行队列（2026-09-30 验收登记，见 P4-03）**：请求提交后唤醒执行器只能"安排"
  （`executionContext.waitUntil`，或唤醒只设 alarm、不进串行链），不能 `await` 排在 DO 正在做的工作后面。
  否则响应时间取决于别的请求触发的外调；在认证路径上，这就是分出已注册与未注册的时序旁路（§5.3）。

## 6. 迁移

- 文件名 `NNNN_<简述>.sql`，顺序编号，**只进不退**。
- 已发布数据的破坏性变更（DROP、改已发布 URL 语义、重写 UID）需先有 ADR。
- 每个迁移配一条可重放性测试：空库依次执行全部迁移 → schema 与索引符合预期。
- 代码回滚不等于数据库回滚；回退点在交付报告里写清楚。

## 7. 测试分层与命名

| 层 | 位置 | 跑什么 |
| --- | --- | --- |
| L1 纯函数 | `packages/contracts/**/*.test.ts` | 枚举、规范化、投影语义、日池与 floor 降级计算、等式校验 |
| L2 Worker 集成 | `apps/worker/**/*.test.ts` | 真实 D1/DO 上的条件提交、并发、限速、状态机 |
| L3 合同 | `tests/contract/**` | API 请求/响应 schema、错误码、幂等、权限边界 |
| L4 纵向闭环 | `tests/flows/**` | 每阶段一条端到端路径（如"注册→保存→启用 Feed→拉取 ICS"） |
| L5 前端 | `apps/web/**` + `tests/e2e/**` | 组件交互、键盘与读屏可达、Playwright 截图 |

**测试 ID 必须可 grep。**每个验收点在测试标题里带上验收 ID：

```ts
describe('A-P2-SESSION 会话生命周期', () => {
  it('U14 active 名额已满时由用户选择撤销，不自动淘汰最早会话', async () => { /* ... */ })
})
```

验收 ID 清单见 `docs/ACCEPTANCE.md`。交付报告里的"验收测试"表直接引用测试文件与用例名。

**已知偶发（flake）**：`pnpm test` 全量并行跑（contracts 与 worker 同时）时，
worker 侧曾两次各挂 1 条用例（一次在 `crypto/mac.test.ts`），单独 `pnpm --filter @hoyo/worker test`
与连续三轮全量复跑均全绿，判定为 miniflare/workerd 并发抖动而非逻辑缺陷。
**遇到时先复跑确认，不要直接改测试来"修"它**；若复现率上升或能稳定复现，按缺陷处理并单独开卡。
CI 偶发红比测试缺失更伤——它教人忽略红灯。

> **2026-09-27 升级为缺陷 → P2-08（已合入 `38a91d4`）。定因结果推翻了上面的判断：**
> - `mac.test.ts` **不是并发抖动，是测试本身的概率 bug**：它把 MAC 首字符换成 `0` 来"损坏"MAC，
>   而随机 MAC 首字符本来就是 `0` 的概率是 1/16——此时"损坏"后与原值相同，校验正确地通过，测试却期待失败。
>   P2-08 在基线第 48 轮复现并据此修正。上面"判定为 miniflare/workerd 并发抖动"是验收方误判。
> - `admission.test.ts` 的折叠计时断言才是真正的负载敏感：四条路径各自连续采样，负载漂移只压在一段上。
>   已改为逐轮交替采样，比值上限 2.5 倍不变，检出能力经两组变异验证（比值 11.33 与 12）。
>
> 教训：**"只在并行时失败"不等于"是并发问题"**——先复现拿到实际断言输出，再下结论。

**本地 e2e 与 astro preview 守护进程（2026-09-27）**：Astro 7.3.3 的 `astro preview` 被 Playwright
拉起时会自行转入后台并以 0 退出；它按项目在 `apps/web/.astro/preview.json` 写锁，锁在时忽略 `--port`，
端口被占时会悄悄换端口；守护进程成为孤儿后长期存活。**F1-05 合入之前，本地 `pnpm test:e2e` 不可靠**，
CI 上的绿也是赢了竞态。跑过 e2e 或 `astro preview` 之后要清理：

```bash
cd apps/web && npx astro preview stop    # 停掉本项目登记的守护进程并清锁
lsof -nP -iTCP:4173 -sTCP:LISTEN          # 确认 4173 没有残留
```

在别的 worktree 里起的守护进程只能到那个目录里 stop；目录已删的，按 PID 结束。
F1-05 已合入（`861c4c2`）：e2e 改由 `scripts/e2e/serve.mjs` 前台服务，端口被占时立即失败并点名占用者；
上面的清理命令仍适用于手动跑 `astro preview` 之后。#89 起可用 `E2E_PORT`（默认 4173）与 `E2E_DIST` 换端口与构建目录，
结果目录随端口隔离（`.gitignore` 收录 `dist-*/`、`test-results-*/`），几个工作树可以并行跑 e2e。

**并发与竞态必须真测**：验证码并发消费、两设备同时保存、会话名额争用、预算并发预占，都要写成真实并发用例，不用"逻辑上不可能"代替。

**e2e 不得覆盖已提交的证据（2026-09-28 登记）**：普通 `pnpm test:e2e` 只把截图写进 `test-results/`；需要更新 `tests/e2e/evidence/**` 时显式设环境变量再跑。F1-02 的 `schedule.spec.ts` 目前每跑一次就改写 4 张证据截图，已登记由 F2-03 顺手修正。2026-09-29 复查：F1-03 的 `event-detail.spec.ts` 同样每次改写 `tests/e2e/evidence/f1-03/` 的 6 张截图，一并交 F2-03 修。F2-03 已修好这两处（环境变量 `HOYO_E2E_WRITE_EVIDENCE=1` 才写已提交证据，否则写进忽略的 `tests/e2e/test-results/`）；F1-04 的 `account.spec.ts` 与 F2-01 的 `subscription.spec.ts` 还会改写，交 F2-04 照同样写法修。2026-10-06 复查：`subscription.spec.ts` 已按同样写法加门（F2-04），`account.spec.ts` 已不再写证据；现在写已提交证据的 spec 全部受这个变量控制。

## 8. Git 与 PR

- 主干开发。分支 `<阶段>/<任务卡 ID>-<短描述>`。
- 一张任务卡一个 PR；PR 描述就是 `AGENTS.md` 第 5 节的交付报告。
- CI（`.github/workflows/ci.yml`）依次跑：冻结锁文件安装、`lint`、`typecheck`、`test`、`params:verify`、`migrate:check`、`build`、`test:e2e`，全部必须通过。
- 不在功能 PR 里夹带依赖升级、格式化全量改动或无关重构。
- **worktree 建在仓库外**（如 `/tmp/<卡号>`）。建在 `.worktrees/` 下有两个后果：Biome 报
  "Found a nested root configuration" 使 `lint` 在本地失败（干净检出的 CI 看不到），
  且容易被 `git add -A` 误收为 gitlink——`0e1bc13` 已经发生过一次。
  `.gitignore` 已收录 `.worktrees/`，但 **gitignore 对已跟踪路径无效**，
  已入库的 gitlink 需 `git rm --cached <路径>` 解除跟踪。
- Claude Code 会话的工作树在 `.claude/worktrees/<名>`，由本机 `.git/info/exclude` 排除，`pnpm lint` 不会扫进去；
  新工作树只有根 `node_modules`，跑测试前先在工作树根执行 `pnpm install --frozen-lockfile --offline`。

## 9. Definition of Done

一张任务卡完成，当且仅当下列全部成立：

1. 任务卡"交付物"逐项完成，或未完成项在报告中明确说明并有处理结论。
2. 该卡的验收 ID 全部有对应测试且**实际跑过**；未覆盖项已说明原因。
3. `lint`、`typecheck`、`test`、`params:verify`、`migrate:check` 全绿，输出贴进报告；动到网页或构建的卡另跑 `build` 与 `test:e2e`（CI 同样会跑，验收方复核时按八条命令全跑）。
4. 没有新增第二份参数常量、没有新增第二份业务规则定义。
5. 未命中 `AGENTS.md` 第 3 节禁止清单。
6. 秘密扫描通过：改动文件中不含密钥、真实邮箱、真实 token。
7. 改动范围未超出任务卡授权路径，或超出部分有理由。
8. 交付报告完整，含回退点。

**"代码能跑"不是完成。"测试没写但我确认逻辑正确"不是完成。**
