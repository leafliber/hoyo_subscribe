# P5-04 开工测量清单

基线 origin/main efb320e（2026-10-03）；前置 13ddad2 / 68d0f41 / 3b8c643 均为祖先，无同卡在途 PR。仅本地隔离开发；正式站点 https://hoyo.airo.cc 由所有者部署。当前迁移最大 0026；本卡不计划迁移、业务参数或生产开关修改。

| 场景 | 数据来源与实际执行边界 | 现有参数来源 | 证据目标 |
| --- | --- | --- | --- |
| 冷/热公开读、静态页面 | 本次网页构建 + 单 Worker assets；隔离 D1 合成来源/节点 | PUBLIC_CACHE_FRESH、PUBLIC_READ_LIMITS、SOURCE_LIMIT_PROFILE | E1/E2 响应、吞吐/延迟、实际查询读写；静态与动态分开 |
| 授权 Feed GET/HEAD/304 | 合成账号与真实生产授权/完整快照路径，撤销后再读热缓存 | FEED_*、PUBLIC_CACHE_FRESH | E1/E2；HEAD/304 不能绕授权 |
| 私人预览 | 合成有效会话、真实分页及限流 | CALENDAR_PREVIEW_RATE_*、PUBLIC_READ_LIMITS、PUBLIC_CACHE_FRESH | E1/E2；成功样本不外推任意 blocked 集合 |
| 本地假供应商外发 | 生产账本/outbox + 仅本地 provider；日池/floor/unknown/跨日 | MAIL_AUTH_DAY、MAIL_BASE_DAY、MAIL_URGENT_DAY、MAIL_*_FLOOR、PLATFORM_MAIL_DAY_LIMIT | E1/E2；accepted 不当送达 |
| 容量、续租与回收 | 合成账号/席位满容量；生产暂停门、维护者确认与清理 | ACCOUNT_MAX_STORED、MAIL_SEATS_MAX、MAIL_ROUTINE_SEATS_MAX、ACCOUNT_IDLE_DAYS、ACCOUNT_GRACE_DAYS、RECLAIM_QUERY_BUDGET | E1/E2；释放存量不退日额度 |
| 满轮反馈 + 回收 | 同一次维护调用中的实际 D1 语句计数与读写 | FEEDBACK_*、RECLAIM_QUERY_BUDGET、EXECUTOR_BATCH_WALL_LIMIT、平台 queryLimit | E1/E2；不把预算上限当已用量 |
| 账单对账 | 脱敏应用账本与所有者提供的平台观测；先用 synthetic 输入验证工具 | 三个 UTC 日池与 contracts UTC 桶 | E1；真实对账 E3 未执行 |
| 帮助/状态 | contracts 参数、P0 已登记客户端范围、公开 status API | 参数直接导入；unknown 保持未知 | E1/E2 双视口与 U28；组件测试迁到测试专用夹具 |

计量边界：本地 wall time / Node CPU / workerd D1 rows 是本地测量，不是平台 CPU 或费用。Workers 请求与计费 CPU、D1 读/写/存储、两个固定 DO 请求/时长/存储、Queue 操作/重试/DLQ、邮件日权限分别登记。settled、reserved、uncertain 保持分列；未外调预留跨日迁移与已调用跨日接受分别对账，其他应用占用不塞进本应用日池。缺值不填零，不按本机 CPU 推算平台账单，不恢复月度池。

E3 缺口（均未执行/未知，需所有者提供）：目标来源可达性，D1 条件事务与读写/容量，DO alarm/发送位置，Queue/DLQ，真实计费 CPU/套餐包含量/账户其他用量/账单，认证域时延与反馈、业务两退订头签名覆盖，独立加密介质及分离密钥/当前 epoch、目标导出阻塞/恢复时长。前端全链仍须 F3-04/F3-05 验收。此卡本地通过不能判定最终上线通过。

工具/测试骨架：scripts/load 下独立运行的本地负载入口、对账 CLI 与自动化测试；tests/e2e/release.spec.ts 公开限制/状态回归；tests/e2e/fixtures/p5-release 仅测试夹具。所有原始输出留源码外，只提交脱敏汇总。先运行备份专项与 CLI 演练；交付完整顺序八命令（build 外层 300 秒）、站点冒烟、新工具测试。变异先确认替换一次、非空 diff，恢复后重测。
