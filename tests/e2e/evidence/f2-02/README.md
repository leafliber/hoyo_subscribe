# F2-02 合成浏览器证据

全部截图由真实构建的 `/subscription` 页面生成。原有 14 张仅拦截 API；新增 `local-api-*` 两张直连本地真实 Worker 和隔离 D1，没有拦截或替换 API。活动与来源均为 synthetic 夹具，不是真实来源、账号、发信或外部日历兼容性证据。页面中的“真实数据”是被测 API 成功分支的产品文案；截图内容仍全部为合成。

生成命令（2026-10-02，本地 Chromium）：

```sh
CI=1 WRANGLER_SEND_METRICS=false HOYO_E2E_WRITE_EVIDENCE=1 pnpm test:e2e calendar-preview.spec.ts
```

最后一次结果：56 passed（桌面 Chromium 与 Pixel 7 Chromium，各 28 项）。普通 `pnpm test:e2e` 只写忽略的 `tests/e2e/test-results/f2-02/`，不覆盖本目录。

| 文件前缀（每种含 desktop/mobile） | 场景 |
| --- | --- |
| hidden-node | 隐藏结束节点，提醒仍引入同一身份 |
| hidden-event | 隐藏事件类型，提醒仍引入同一身份 |
| hidden-both | 两种筛选同时隐藏，两项原因都展示 |
| precision | 精确、预计、纯日期排序与闹钟解释；未知时间仅计省略 |
| corrections | 官方取消、撤回、删除、延期待定与改期跨窗；注入字符串按文本显示 |
| 503 / offline | 真实数据不可用时的明确合成样例降级 |

`local-api-desktop.png` / `local-api-mobile.png` 于 2026-10-02 08:47 UTC 采集：原分支 merge 已验收的 P3-15（main `cd232d5`）后，用锁定的 Wrangler `dev --local`、完整迁移的隔离 D1 和 Chromium 访问构建页面。库内注入一条精确结束节点、一条未知时间节点、一条有旧时间更正的延期待定节点及一条窗口外历史节点；页面显示 2 条、时间待定省略 1 条，历史节点不进入候选。临时脚本和日志保留在源码外，运行命令及完整证据见 PR #69 交付报告。

实现通过 `@hoyo/contracts` 消费已合入的候选、解释、排序、上限及来源规则，相对 main 无 contracts 修改。F3-04 启用确认与实际客户端兼容性验证仍不在本卡证据范围。
