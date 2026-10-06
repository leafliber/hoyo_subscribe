# 浏览器通知（F5-01）

依据：前端 §9.3、§9.4、§10.1、§10.2；主方案 §7.8；D3 §1.2、§1.3、§2.8；ADR-0025。

- `browser.ts`：能力检测、系统权限、Service Worker 注册与推送订阅；本机记录 `{ binding_id, receipt_token }`
  存在 IndexedDB `hoyo-push`（与 `/sw.js` 共用，常量两处一致）。只有点击后才申请权限、注册、订阅。
- `api.ts`：`/api/v2/me/push-bindings*` 请求；视图用 contracts `PushChannelViewSchema` 严格解析，缺字段即失败。
- `panel.ts` / `lifecycle.ts`：订阅页「浏览器通知」卡片。能力未开放且本人没有任何绑定时不出现；
  开启流程：申请权限 → 订阅 → 登记（拿到一次性 receipt token）→ 存进本机 → 请服务器发可见激活通知。
  浏览器权限与服务端绑定分开显示；只有服务端因合法回执转为 active 后才显示「本浏览器接收验证通过」。
  Service Worker 报回执后用 `postMessage` 通知页面重读；页面不轮询、不发测试心跳。
- `account.ts`：账号页「浏览器通知」分区与「退出并暂停本浏览器通知」（先暂停再退出，逐项报告）。
- 迟到结果：订阅页每张卡片一个世代，身份切换、退出或页面隐藏即作废，作废的卡片不再碰 DOM（同一根节点可能
  已挂上新身份的卡片）；读写进行中又要求刷新（回执、切回页面、保存了新版本）时排队到当前请求结束后再读，
  旧的写结果不会盖掉更新的状态。账号页分区 `clear()` 推进世代，迟到的读取或操作结果一律丢弃。
- `copy.ts`：文案；数值只取 contracts 的 `PUSH_DISCLOSURE`。

置灰与原因一律来自 contracts `derivePushActions`；写接口被拒时按同一 `blocked_reason` 显示。
结果未知（断网、超时、5xx 无结构化错误体）时不当作成功或失败，重新读取核对。

标准浏览器验收：`tests/e2e/push.spec.ts`（U23）与 `tests/e2e/account-management.spec.ts`（U24）。
浏览器的 Notification / Service Worker / PushManager 在 E2E 里是合成替身，不能代替 P6-03 的真实客户端取证
（`docs/evidence/p6/README.md`）。
