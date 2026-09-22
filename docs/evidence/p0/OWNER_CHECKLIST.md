# OWNER_CHECKLIST · 需所有者执行的操作清单（P0）

> 任务卡 P0-01 交付物。执行者 Agent 无权开通收费资源、无法登录真实账户、无法操作真实收件人与客户端。
> **以下 §B 是 P0-01 探针取得目标环境（E3）证据所需的最小操作集**；§C–§E 是任务卡要求的另几类
> 所有者操作的登记入口，其正式步骤由各自任务卡（P0-03 / P0-04 / P0-05）细化，本清单不代替它们。
>
> 原则（AGENTS.md 规则 5、任务卡 P0 三条铁律）：
> 1. 每一步都由你决定是否执行；探针代码本身不开通任何资源。
> 2. 产生费用/登录的操作都标了 ⚠。
> 3. 取证后立即清理临时资源；探针一律禁止公开部署。

## §A 一次性准备

| # | 操作 | 说明 |
| --- | --- | --- |
| A-1 | 安装 Node ≥ 20 与 `npx` | 本地 runner 与 `save-from-url.mjs` 需要 |
| A-2 | ⚠ `npx wrangler@4 login` | OAuth 登录 Cloudflare 账户；仅用于 `wrangler dev --remote` 临时运行，不部署任何 Worker |
| A-3 | 读 `docs/evidence/p0/README.md` | 证据命名、字段含义与秘密政策（提交前脱敏 database_id / account 标识等） |

## §B P0-01 四个探针的目标环境取证（G-P0 证据只认这里的产出）

### B-1 sources-reachability（来源可达性 · 目标环境）

```bash
cd scripts/probes/sources-reachability/worker
npx wrangler@4 dev --remote --port 8790        # 在 Cloudflare 边缘运行
# 另开终端：
node scripts/probes/save-from-url.mjs sources-reachability "http://127.0.0.1:8790/probe" --type remote-worker
# Ctrl-C 停止 dev server
```

要点：出现 `restriction_signal` 时这就是结论本身（来源受限，按 §3.1 停用该来源并标维护，不绕过）；
不需要也没有"换 UA 再试"的步骤。

### B-2 do-send-location（DO 位置与 alarm · 目标环境）

```bash
cd scripts/probes/do-send-location
npx wrangler@4 dev --remote --port 8792
# 另开终端，依次：
curl "http://127.0.0.1:8792/probe/observation"
curl "http://127.0.0.1:8792/probe/alarm?delay_ms=2000" && sleep 5
curl "http://127.0.0.1:8792/probe/serialization?n=8&delay_ms=150"
node scripts/probes/save-from-url.mjs do-send-location "http://127.0.0.1:8792/probe/report" --type remote-worker
# Ctrl-C 停止 dev server
```

要点：看 `front_worker.cf_colo` 与 `durable_object.cf_colo`、`alarm_log[].skew_ms`、
`serialization.*.lost_updates`。remote 模式下请求经 CF 边缘进入 DO，观测到的 colo 才是目标环境结论。

### B-3 d1-conditional-tx（D1 条件事务 · 目标环境）

1. ⚠ 创建**临时** D1（免费额度内，是否创建由你决定）：

   ```bash
   npx wrangler@4 d1 create p0-probe-scratch
   ```

2. 把返回的 `database_id` 填进 `scripts/probes/d1-conditional-tx/wrangler.jsonc`（替换占位符）。
3. 运行并取证：

   ```bash
   cd scripts/probes/d1-conditional-tx
   npx wrangler@4 dev --remote --port 8791
   # 另开终端：
   node scripts/probes/save-from-url.mjs d1-conditional-tx "http://127.0.0.1:8791/probe" --type remote-worker
   # Ctrl-C 停止 dev server
   ```

4. ⚠ 取证完成后清理（可选但建议）：`npx wrangler@4 d1 delete p0-probe-scratch`。
5. 提交证据前把 `database_id` 从 wrangler.jsonc 改回占位符（秘密政策）。

要点：`results.summary.dependent_write_persisted_despite_cas_zero_rows = true` 即证实
「CAS 零行不会让 batch 回滚」（[R08]），P1-05 的条件提交原语必须自带统一条件守卫。

### B-4（占位，无额外操作）

本节号保留给后续任务卡补充；P0-01 无 B-4 操作。

### B-5 model-echo（模型 usage 字段发现 · 目标环境）

⚠ **每次调用 `/probe?run=echo-once` 都产生真实模型用量/费用**（Workers AI 按 Neurons 计量，
免费计划有上限、Paid 按量计费）。只跑一次，取证后立即 Ctrl-C。

```bash
cd scripts/probes/model-echo
npx wrangler@4 dev --remote --port 8793
# 另开终端：
node scripts/probes/save-from-url.mjs model-echo "http://127.0.0.1:8793/probe?run=echo-once" --type remote-worker
# 立即 Ctrl-C 停止 dev server
```

要点：看 `results.result.usage_field_names`——这是"完整计费输出"字段发现的第一步；
可见 JSON 大小 ≠ 计费输出（§3.5），后续分布与上界测定属 P0-03。
更换模型 profile：编辑 `wrangler.jsonc` 的 `MODEL_PROFILE_ID` 或 `npx wrangler@4 dev --remote --var MODEL_PROFILE_ID:<id>`。

### B-6 取证后清理清单

- [ ] 所有 `wrangler dev` 已停止（没有残留终端）
- [ ] 未执行过 `wrangler deploy`（探针禁止公开部署）；若误部署，立即在控制台删除
- [ ] `d1-conditional-tx/wrangler.jsonc` 的 `database_id` 已恢复占位符
- [ ] 临时 D1 `p0-probe-scratch` 已删除（或确认保留意图）
- [ ] 证据文件已按 README §3 秘密政策过目后再提交

## §C 账单与平台资格查询（为 P0-03 / P0-05 预留登记入口）

⚠ 需要真实账户控制台，Agent 无法代查。正式步骤与字段清单由任务卡 **P0-05** 细化，此处仅登记入口：

- Workers 计划状态（Free / Paid）与账单周期起止：dashboard → Workers & Pages → Billing/Usage；
- Email Sending 资格与状态（当前 Beta）：dashboard → Email → Email Sending；
- 账户日发信权限与其他应用额度占用：dashboard → Email 用量页（不能从月包含量推导，§2.2）；
- Workers AI 用量与 Neurons 限额：dashboard → Workers AI。

## §D 真实收件人测试（P0-05 范围，此处登记入口）

⚠ 涉及真实发信与 DNS 配置，Agent 不执行。授权的普通收件箱（QQ/163/Gmail/Outlook 等，**非** routing
verified destination）的发送与反馈 Queue 关联实测，按任务卡 **P0-05** 的步骤文档执行。

## §E 日历客户端安装与实测（P0-04 范围，此处登记入口）

目标客户端（Apple Calendar / Google Calendar / Outlook 等）的安装、版本记录、ICS 序列实测，
按任务卡 **P0-04** 的静态托管脚本与登记表执行；每个客户端单独一行结论，不共用"支持"表述（§10.3）。
