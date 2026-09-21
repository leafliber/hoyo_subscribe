# scripts/probes · P0 能力探针（只读，不开通资源）

> 任务卡 P0-01。四个探针各自独立可跑，输出结构化 JSON 到 `docs/evidence/p0/<probe>-<YYYYMMDDTHHMMSS>Z.json`。
> 证据字段含义、命名规范与秘密政策见 `docs/evidence/p0/README.md`；目标环境操作见 `docs/evidence/p0/OWNER_CHECKLIST.md`。
> P0-02 新增 `source-samples` 采集器（见下表末行），同样遵循本文件的安全边界。

## 探针总览

| 探针 | 观测什么 | 本地跑法（无需账户） | 目标环境跑法（需所有者） |
| --- | --- | --- | --- |
| `sources-reachability` | 四个官方来源线索 URL 的可达性、状态码、响应大小、鉴权/验证码/访问限制信号 | `node scripts/probes/sources-reachability/run-local.mjs` | `cd scripts/probes/sources-reachability/worker && npx wrangler@4 dev --remote --port 8790`，再 `node scripts/probes/save-from-url.mjs sources-reachability "http://127.0.0.1:8790/probe" --type remote-worker` |
| `d1-conditional-tx` | D1 batch 与 CAS 的真实行为：**CAS 更新零行时 batch 是否回滚**（§3.6、§8.1） | `node scripts/probes/d1-conditional-tx/run-local.mjs` | 替换 wrangler.jsonc 中的 `database_id` 后 `npx wrangler@4 dev --remote --port 8791`，再 `node scripts/probes/save-from-url.mjs d1-conditional-tx "http://127.0.0.1:8791/probe" --type remote-worker` |
| `do-send-location` | DO 请求两侧的 colo/ray 字段、alarm 无请求自触发、读-等-写/紧凑读写的丢失更新差异 | `node scripts/probes/do-send-location/run-local.mjs` | `npx wrangler@4 dev --remote --port 8792`，再 `node scripts/probes/save-from-url.mjs do-send-location "http://127.0.0.1:8792/probe/report" --type remote-worker`（建议先依次访问 `/probe/observation`、`/probe/alarm?delay_ms=2000`、等 5 秒、`/probe/serialization?n=8&delay_ms=150`） |
| `model-echo` | 模型 profile 对固定合成样本的 usage/计费字段发现（不做质量评估） | **不可本地运行**（Workers AI 仅 remote 可用） | `npx wrangler@4 dev --remote --port 8793`，再 `node scripts/probes/save-from-url.mjs model-echo "http://127.0.0.1:8793/probe?run=echo-once" --type remote-worker`（⚠ 每次调用产生真实用量/费用，取证一次即止） |
| `source-samples`（P0-02） | 按已核验参数采集四个官方来源的真实样本到 `fixtures/sources/`，实测 SOURCE_LIMIT_PROFILE | `node scripts/probes/source-samples/run-local.mjs [--only <source_id>]`；离线重算分析：`--reindex`；证据对照：`node scripts/probes/source-samples/analyze-time.mjs` | 未建 worker 版；目标环境复测属"需所有者执行"（见 `docs/evidence/p0/source-params.md` §5） |

## 前置要求

- 本地 runner：Node ≥ 20（`node --version`）；无任何 npm 依赖（纯内置）。
- Worker 探针：`npx --yes wrangler@4`（首次自动下载）；本地 `wrangler dev` 不需要账户登录。
- 目标环境：所有者先 `npx wrangler@4 login`，并按 `OWNER_CHECKLIST.md` 操作。

## 只读与安全边界（硬约束）

- 对外部来源：仅 GET、域名白名单（固定在 `sources.lead.json`）、不跟随重定向、超时与大小上限、诚实 UA、无凭据、不重试；出现鉴权/验证码/访问限制信号即记录并放弃该来源（§3.1），**不实施绕过、不伪装 UA、不使用第三方聚合后端**。
- `d1-conditional-tx` 观测 batch 语义必须真实写入：它只创建/删除**自己的临时表** `p0_probe_cas` / `p0_probe_log`，不接触任何业务表；请绑定临时/专用探针数据库。
- `model-echo` 只使用 `sample.synthetic.json`（`synthetic: true`）固定合成样本，不含官方公告内容与用户数据。
- 所有探针**禁止公开部署**（`wrangler deploy`）；取证用 `wrangler dev` 临时运行。
- 限制信号识别是启发式（供人工复核），见 `lib/guard-core.mjs` 与证据 README。

## 目录结构

```text
scripts/probes/
├── lib/                     共享：受限 fetch/信号识别（guard-core）、证据信封（evidence）、wrangler dev 启停（spawn-wrangler）
│   └── *.test.mjs           单元测试（node --test），标题带 A-P0-PROBE
├── sources-reachability/    线索清单 + 本地 runner + Worker 版
├── source-samples/          P0-02：已核验参数清单 + 采集 runner + 离线重析/证据生成（单测标题带 A-P0-SOURCE）
├── d1-conditional-tx/       Worker 实验 + 本地 runner
├── do-send-location/        Worker + DO + 本地 runner
├── model-echo/              Worker + 固定合成样本
└── save-from-url.mjs        把 Worker 探针输出落盘为证据文件
```

## 测试

```bash
node --test scripts/probes/lib/ scripts/probes/source-samples/
```

## 回退点

`scripts/probes/` 与 `docs/evidence/` 可整体删除，不影响其他目录（任务卡 P0-01 回退条款）。
