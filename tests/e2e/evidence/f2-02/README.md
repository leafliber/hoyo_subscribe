# F2-02 合成浏览器证据

全部截图由真实构建的 `/subscription` 页面生成，仅拦截 API。活动、身份、来源及时间均为 synthetic 夹具，不是真实来源、账号、发信或外部日历兼容性证据。页面中的“真实数据”是被测 API 成功分支的产品文案；截图内容仍全部为合成。

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

实现通过 `@hoyo/contracts` 消费上游 #68 的候选、解释、排序、上限及来源规则；本卡分支的 contracts 提交为原样依赖引入。P3-15 尚未验收合入，正式前后端联调、F3-04 启用确认与实际客户端兼容性验证均未执行。
