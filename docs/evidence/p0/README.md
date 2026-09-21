# docs/evidence/p0 · P0 证据登记（只读探针产物）

> 任务卡 P0-01 交付物。本目录存放四个探针的结构化 JSON 证据，以及需所有者执行的操作清单。
> **不得用模拟结果填充 P0 证据**；探针跑不通就如实保存失败输出（BUILD_PLAN §2 P0 现实性说明）。

## 1. 文件命名规范

```text
<probe>-<UTC时间戳>.json          例：sources-reachability-20260922T051234Z.json
<probe>-<UTC时间戳>-<序号>.json    同一秒重复写入时的去重后缀（02 起）
```

- `<probe>` ∈ `sources-reachability` / `d1-conditional-tx` / `do-send-location` / `model-echo`。
- 时间戳为 UTC，格式 `YYYYMMDDTHHMMSSZ`（文件名安全）。
- 人工补录的结论、截图、控制台导出等非探针产物用描述性文件名，扩展名 `.md` / `.png` / `.txt`，同样带 UTC 日期（例：`calendar-clients-20260922.md`，P0-04 起用）。

## 2. 证据信封（每个探针 JSON 的公共结构）

| 字段 | 含义 |
| --- | --- |
| `probe` | 探针名，与文件名前缀一致 |
| `schema_version` | 证据结构版本，当前 `1` |
| `generated_at_utc` | 证据写入时间（信封创建时刻，ISO 8601） |
| `run_environment` | **运行环境标注**，见下表；决定证据等级 |
| `results` | 探针观测结果（各探针字段字典见第 4 节） |
| `notes` | 探针自述的注意事项 |

### run_environment.type 与证据等级（对照 docs/ACCEPTANCE.md §2）

| type | 含义 | 等级 | 能否用于 G-P0 放行 |
| --- | --- | --- | --- |
| `local-node` | 本机网络直连（`run-local.mjs`，sources 探针） | E2 受控观测 | 否 |
| `wrangler-dev-local` | 本地 miniflare/workerd（`run-local.mjs`，d1/do 探针） | E2 受控观测 | 否 |
| `remote-worker` | Cloudflare 边缘/目标账户运行（所有者经 `save-from-url.mjs` 落盘） | E3 外部事实 | **是** |
| `owner-manual` | 所有者手工执行并落盘 | 按操作方式评定 | 视操作方式 |

**本地证据的价值是验证探针自身可用与提供对照基线；G-P0 放行只认 `remote-worker`（E3）。**

## 3. 秘密政策（提交前逐条自查）

**禁止出现在本目录任何文件里**：

- Cloudflare API Token、wrangler OAuth 凭证、`.dev.vars` 内容；
- 账号登录邮箱、账单地址、收款信息；真实用户邮箱等任何个人数据；
- Cookie、OTP、恢复码、Feed/退订 URL、Push endpoint 与密钥（AGENTS.md 规则 7 的全集）；
- `database_id`、account ID 等账户标识（remote 取证时请从 wrangler 输出中剥离后再落盘）；
- 任何含上述内容的截图（截图先脱敏再入库）。

**允许出现**：公开来源 URL、HTTP 状态码与响应头子集、响应大小与 hash、公开公告 JSON 的顶层结构键名与标量信封、colo 名称、cf-ray、sqlite 版本、D1 meta 字段名与数值、模型 usage 字段名与数值、时间戳。

探针代码已按此设计（不保存完整响应正文，只保存派生字段）；手工补录时同样遵守。

## 4. 各探针 results 字段字典

### 4.1 sources-reachability

`results.sources[]`（每来源一条）：

| 字段 | 含义 |
| --- | --- |
| `id` / `label` / `url` / `host` | 线索标识与实际请求 URL（§3.1 线索，`lead.verification_state=lead-unverified`） |
| `elapsed_ms` | 请求耗时 |
| `error` | `null` 或 `{kind: guard\|timeout\|network, code, message}` |
| `http.status` / `http.redirect_status` / `http.followed_redirect` | 状态码；`redirect_status` 非 null 表示遇到重定向，探针**未跟随** |
| `http.headers` | content-type/length、location、www-authenticate、cf-mitigated、cf-ray、server、retry-after 子集 |
| `body.bytes_read` / `body.truncated` / `body.sha256` | 大小、是否超上限截断、正文 hash（**不存正文**） |
| `body.json_top_level_keys` / `body.json_envelope_scalars` | 响应 JSON 顶层结构键名与标量信封（观察 retcode/message 等包裹层） |
| `restriction.restricted` / `restriction.signals[]` | 启发式受限信号（http_status / www_authenticate / cf_mitigated / body_envelope_marker / body_prefix_marker） |
| `outcome` | `reached` / `restriction_signal` / `http_error_status` / `network_error` / `guard_error` |

`results.summary`：各类 outcome 的计数。

### 4.2 d1-conditional-tx

`results` 为 Worker `/probe` 的 `experiment` 对象：

| 字段 | 含义 |
| --- | --- |
| `summary.sqlite_version` | 目标 D1 的 SQLite 版本 |
| `summary.batch_rolls_back_on_sql_error` | E1：batch 内 SQL 语法错误时，同批先前 UPDATE 是否被回滚 |
| `summary.cas_zero_rows_batch_threw` | E2：CAS 更新命中 0 行时 batch 是否报错 |
| `summary.dependent_write_persisted_despite_cas_zero_rows` | **E2 核心**：CAS 零行后，同批依赖写入是否照样提交（[R08] 风险事实） |
| `summary.batch_rolls_back_on_cas_zero_rows` | E2：CAS 零行是否使整批回滚 |
| `summary.changes_guard_insert_ran_when_update_matched` / `changes_guard_blocked_dependent_write_on_miss` | E3：`INSERT ... WHERE changes()=1` 守卫在同批内的放行/拦截行为 |
| `summary.single_cas_miss_threw` / `single_cas_miss_changes` / `single_sql_error_threw` | E4：单条语句层面「条件未命中」与「数据库报错」是否为两种不同结果 |
| `steps[]` | 每步的 SQL 意图、是否抛错、错误摘要、batch meta、附加观测 |
| `d1_meta_fields_observed` | 实际观测到的 D1 result meta 字段名集合（字段发现） |
| `cleanup_ok` | 探针临时表 `p0_probe_cas` / `p0_probe_log` 是否已清理 |

### 4.3 do-send-location

| 字段 | 含义 |
| --- | --- |
| `results.observation.front_worker` / `.durable_object` | 前台 Worker 与 DO 各自看到的 `cf.colo` / `cf-ray`（字段发现，以实际出现为准） |
| `results.alarm_set` | 设置 alarm 的计划时刻 |
| `results.report.durable_object.alarm_log[]` | alarm 自触发记录：`scheduled_for_ms`、`fired_at_ms`、`skew_ms`（无外部请求自行触发） |
| `results.serialization.slow_interleaved` | 读-等-写模式：`final_counter` 与 `lost_updates`（>0 = 等待窗口放行并发） |
| `results.serialization.compact` | 紧凑读写模式：`lost_updates`（=0 = 存储操作期间输入门禁串行化） |
| `results.report.durable_object.req_log[]` | DO 收到的请求记录（路径、colo、ray、时刻），上限 100 条 |

### 4.4 model-echo

| 字段 | 含义 |
| --- | --- |
| `results.model_profile_id` | 实际调用的模型（默认 `@cf/qwen/qwen3-30b-a3b-fp8`，§3.5 测试对象） |
| `results.request_params` | 发送的参数（messages 摘要 + max_tokens） |
| `results.sample` | `synthetic: true`、`sample_id`、样本文件 hash |
| `results.result.top_level_field_names` | 模型返回顶层字段名集合（字段发现） |
| `results.result.usage_raw` / `usage_field_names` | **完整 usage 对象原样与字段名**（计费字段发现，P0-01 的核心目的） |
| `results.result.response_text_sha256` / `response_text_prefix_200` | 输出指纹与前 200 字符（不做质量评估） |
| `results.result.elapsed_ms` | 调用耗时 |

## 5. 与后续任务卡的关系

- P0-02 起来源真实样本存 `fixtures/sources/`（不存本目录）；本目录只放探针输出与人工结论。
- P0-06 的 `CONCLUSIONS.md`（结论表）将引用本目录文件路径作为证据。
