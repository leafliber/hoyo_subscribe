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
│   ├── web/                   Astro 静态站点 + 小型 TS 模块
│   │   └── src/
│   │       ├── pages/         路由、静态骨架、按需加载入口
│   │       ├── components/    字段、按钮、提示、对话框、日期组、节点条目
│   │       ├── features/
│   │       │   ├── schedule/      公共筛选、列表、详情、数据状态
│   │       │   ├── subscription/  草稿、已保存快照、差异、预览、保存状态机
│   │       │   ├── auth/          预认证、OTP、会话激活、恢复流程
│   │       │   └── channels/      日历、邮件、Push 的状态与操作
│   │       ├── lib/           API 访问、错误映射、按账号本机存储、安全格式化
│   │       └── styles/        设计 token、排版、布局
│   └── worker/                唯一 Worker 项目（原生 fetch handler）
│       └── src/
│           ├── auth/          预认证、OTP、会话、恢复码、最近认证
│           ├── accounts/      用户、订阅配置、换邮箱、删除、导出
│           ├── sources/       来源注册、适配器、采集与游标
│           ├── extraction/    规则 / 模型 / 人工三路与候选审核
│           ├── publishing/    原子发布、三类版本、outbox
│           ├── calendar/      公共快照、更正层、个人 ICS 组装、缩水守卫
│           ├── mail/          发生项、调度、outbox、退订、反馈、抑制
│           ├── push/          绑定、激活、发送、租期
│           ├── executors/     PipelineDO / DeliveryDO / Cron / Queue 消费
│           └── storage/       D1 访问层、条件提交原语、账本
├── packages/
│   └── contracts/             枚举、Schema、参数注册表、规范化纯函数（Worker 与 Web 共用）
├── migrations/                D1 迁移，顺序编号，只进不退
├── fixtures/                  样例数据；合成样本必须带 synthetic 标记
├── tests/                     跨包的集成与纵向闭环测试
└── scripts/                   探针、采集、对账、迁移辅助
```

**禁止**：在 `apps/web` 里引入任何秘密或服务端专用依赖；在 `apps/worker` 各子目录之间建立循环依赖；为单个组件建立独立全局状态；把业务规则写进页面脚本而不是 `packages/contracts`。

## 2. 工具链

| 项 | 选择 | 说明 |
| --- | --- | --- |
| 包管理 | pnpm workspace | 锁文件提交，`packageManager` 字段固定版本 |
| Node | 以 `.nvmrc` 固定 LTS | 本机当前为 v26.8.1、pnpm 11.11.0；P1-01 负责记录实际固定值 |
| 语言 | TypeScript，`strict: true`，禁用隐式 any | 不使用 `any` 逃逸；确需断言时写理由注释 |
| 后端框架 | **不引入 Web 框架**：原生 `fetch` handler + 自建中间件 | 单 Worker，路由按 §1 的子目录挂载；外壳与中间件由 P1-08 交付，P2 起按 `ShellRoute` 挂载 |
| 前端 | Astro 静态输出 + 原生 TS 模块 | 不引入大型前端运行时框架 |
| 校验 | Zod | 类型与运行时校验同源；版本在 P1-01 固定 |
| 测试 | Vitest + `@cloudflare/vitest-pool-workers` | Worker 测试跑在真实 workerd + miniflare D1/DO 上 |
| 端到端（前端） | Playwright | 仅 F 轮使用；截图作为交付证据 |
| Lint/Format | Biome | 单一配置，CI 强制 |
| 部署 | Wrangler | `compatibility_date` 与 Wrangler 版本一起固定，不随手升级 |

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

## 4. 参数与配置

- **唯一来源**：`packages/contracts/src/params/` 导出附录 A 的全部参数。运行参数、文档表格、前端文案里的数值全部从这里取。
- **命名**：与附录 A 完全一致的全大写名（`SESSION_IDLE_TTL`、`MAIL_URGENT_FLOOR`…）。不得用斜杠缩写、不得改名、不得在消费方另起别名。
- **启动校验**：`pnpm params:verify` 与 Worker 启动路径都执行附录 A.5 的依赖等式；任一不成立**拒绝启动**并打印不成立的那一条。
- **P0 待定项**：`MODEL_MAX_INPUT`、`MODEL_MAX_BILLED_OUTPUT`、`SOURCE_LIMIT_PROFILE` 等未填写前，对应能力**默认关闭**，不得用猜测值开启。
- **秘密**：全部经 Wrangler secret 注入；仓库、前端产物、fixtures、日志、错误上下文中一律不出现。部署配置需记录 origin、资源绑定、发件域与实际平台权限（含 `PLATFORM_MAIL_DAY_LIMIT` 实测值）。

## 4.1 成本护栏：不得超出 Workers Paid 套餐

所有者已确认具备 Workers Paid 资格，并给出**硬约束：尽可能不产生套餐之外的额外费用**。
这不是优化目标，是与附录 A 等式同级的运行约束。

| 计量项 | 附录 A 的上限 | 落地要求 |
| --- | --- | --- |
| 邮件 | `MAIL_TOTAL_DAY = 260` | 平台侧唯一硬约束是**日上限**（实测 `PLATFORM_MAIL_DAY_LIMIT = 1,000`，无周期包含量、零其他占用）。须 `MAIL_TOTAL_DAY <= PLATFORM_MAIL_DAY_LIMIT`，当前成立（占 26%）。**已无月度维度**——纯日额度模型见 ADR-0003 |
| 模型 | `AI_SOFT_DAY = 6,000` / `AI_HARD_DAY = 8,000` Neurons | 硬线必须 ≤ 套餐的每日包含量。P0-03 填入实测值后**反向校验这两个数**，超出就往下调 |
| D1 / DO / Queue | 无附录参数 | P5-01 的用量指标必须能看出是否逼近包含量；接近即告警并停止低价值扩大 |

三条规则：

1. **任何"提高上限"的改动都不算优化。**预算不够时正确做法是缩小开放名额或降低能力（§9.1
   "扩大邮件名额必须同时通过月预算、日平滑、平台动态限额和投递质量检查，不能只改 seats 数"）。
2. **不新增计量项。**不引入 R2、Hyperdrive、向量库或任何附录 A 未覆盖的收费产品；确需新增写 ADR。
3. **开发与测试不烧生产额度。**Worker 测试跑本地 miniflare；模型调用在 P0-03 之外一律用固定
   响应替身；探针禁止 `wrangler deploy`，取证用 `wrangler dev` 临时运行后立即停止。

账单告警只是监控，**不是平台收费的绝对封顶**（§10.1）。真正的封顶是账本 + 开关。

## 5. 代码约定

### 5.1 时间

- 精确时间：UTC 毫秒整数。纯日期：`YYYY-MM-DD` 字符串。**两者不得互转**，只有日期不补午夜。
- 每个时间值同时保存 `source_timezone`、`raw_expression`、`time_basis`（`official_explicit / deterministic_derived / official_estimate / unresolved`）与 `precision`（`datetime / date / unknown`）。
- 日桶按固定 UTC 日计算。**邮件预算无月度维度**——每个 UTC 日独立、不跨日结转（ADR-0003）。
- 前端统一展示北京时间 UTC+8 并标明；展示时区切换不改变源事实与提前量。

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

错误对象形状在 `packages/contracts` 定义一次，Worker 与前端共用；前端按 `docs/HOYO_SUBSCRIPTION_FRONTEND_DESIGN_v1.0.md` §11.3 映射到用户可执行的下一步。

### 5.4 数据访问

- 容量与并发一律走条件提交：**禁止 `COUNT` 后无条件 `INSERT`**。账号注册、验证码消费、会话激活、配置 CAS、Feed 换 token、退订、名额释放都必须在同一条件边界内完成。
- D1 `batch` 的 SQL 失败回滚**不等于** CAS 更新零行会自动失败；必须用统一条件守卫或约束让整批写入一起成立或一起失败，并为"数据库报错"与"条件未命中"分别写测试。
- 索引至少覆盖：邮箱键、token hash、所有者、endpoint hash、任务到期、发送状态/优先级、反馈 ID、清理时间、分页 order。测量真实 `rows_read`，不假定位图过滤会命中普通索引。

### 5.5 日志与遥测

- 结构化日志，字段走**白名单**。Cookie、OTP、恢复码、完整邮箱、Feed/退订 URL、Push endpoint 与密钥永远不出现在日志、遥测、错误上下文与截图中。
- 异常请求日志采样，不为每次攻击生成一条持久审计记录。
- 每个运行开关与关键指标在实现时同步登记（见 `docs/tasks/P5-P6.md` 的指标表），不留到 P5 补。

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

**并发与竞态必须真测**：验证码并发消费、两设备同时保存、会话名额争用、预算并发预占，都要写成真实并发用例，不用"逻辑上不可能"代替。

## 8. Git 与 PR

- 主干开发。分支 `<阶段>/<任务卡 ID>-<短描述>`。
- 一张任务卡一个 PR；PR 描述就是 `AGENTS.md` 第 5 节的交付报告。
- CI 必须通过：`lint`、`typecheck`、`test`、`params:verify`、`migrate:check`。
- 不在功能 PR 里夹带依赖升级、格式化全量改动或无关重构。

## 9. Definition of Done

一张任务卡完成，当且仅当下列全部成立：

1. 任务卡"交付物"逐项完成，或未完成项在报告中明确说明并有处理结论。
2. 该卡的验收 ID 全部有对应测试且**实际跑过**；未覆盖项已说明原因。
3. `lint`、`typecheck`、`test`、`params:verify`、`migrate:check` 全绿，输出贴进报告。
4. 没有新增第二份参数常量、没有新增第二份业务规则定义。
5. 未命中 `AGENTS.md` 第 3 节禁止清单。
6. 秘密扫描通过：改动文件中不含密钥、真实邮箱、真实 token。
7. 改动范围未超出任务卡授权路径，或超出部分有理由。
8. 交付报告完整，含回退点。

**"代码能跑"不是完成。"测试没写但我确认逻辑正确"不是完成。**
