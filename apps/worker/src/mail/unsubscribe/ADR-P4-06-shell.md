# ADR-P4-06：先扩展外壳的退订能力协议，再接入退订

- **状态**：提议（P4-06 阻塞，未实现退订）
- **日期**：2026-10-01
- **提出者**：P4-06 执行者 Agent
- **需要所有者批准**：是，需追加外壳文件改动范围；不涉及收费、供应商或平台权限扩大。

本提案沿用 `docs/adr/0000-TEMPLATE.md`，放在本卡授权目录，避免擅改验收方文档或占用全局 ADR 编号。

## 背景

基线 origin/main：`9ee5e18281f23d8ebc63c4c14fd02df3b9de1392`。前置 PR #51、#54 均已合入。
主方案 §7.6 要求：“标准 one-click POST 不要求登录、Cookie、CSRF 或额外交互，不重定向；支持 RFC 指定的表单编码。”
P4-06 卡及本次用户指令要求：“现有外壳若表达不了，先停下，在 PR 里提出最小改动，不绕过外壳。”

现有实现有三处不匹配：

1. `shell/router.ts` 的 `write: true` 分支无条件调用 `readJsonBody`；`shell/body-schema.ts` 明确规定“Content-Type 必须 application/json”。两种标准表单都返回 400，handler 没机会处理。
2. 同一分支无条件调用 `sameOriginCheck`，`csrf: false` 只跳过 CSRF；`shell/origin.ts` 规定“写 API 要求 Origin 存在且与请求的部署源完全一致”。即使诊断时改传 JSON，无 Origin 仍返回 401。`csrf: false` 的声明目前也仅允许预认证初始化使用。
3. `shell/headers.ts` 虽定义了 `CSP_HTML_SAME_ORIGIN`，`applySecurityHeaders` 却无条件覆写为 `CSP_STRICT`（`form-action 'none'`）。HTML 可以返回，但确认表单不能提交；handler 自设 CSP 也被覆盖。

探针 `shell-blocker.test.ts` 通过真实外壳调用重现以上行为，均为本地合成请求，不签发真实 token、不访问生产、不写退订数据。
探针通过只证明阻塞存在，不代表 A-P4-UNSUB 通过；外壳扩展获准后应将这些诊断断言替换为合同成功行为与失败边界测试。

## 受影响的合同

| 文档 | 章节 | 现有规定 | 拟改为 |
| --- | --- | --- | --- |
| 主方案 | §7.6 | 两种标准表单、独立 token 能力、GET 不变更、POST 生效 | 不变，只补外壳表达能力 |
| 主方案 | §8.3 | CSP、no-referrer、严格同源 CORS、无第三方追踪 | 不变，HTML 采用已有同源策略 |
| ENGINEERING | §2 | 业务按 ShellRoute 挂载 | 不变，不在 index.ts 提前截获请求 |

[RFC 8058 §3.1–§4](https://www.rfc-editor.org/rfc/rfc8058.html#section-3.1) 规定独立 POST、无重定向、两种表单编码和 DKIM 头覆盖。
同一绑定跨重新订阅仍可退订是本项目 §7.6 产品合同，不声称 RFC 强制所有链接永久有效。

## 决策

提议追加以下最小范围，等待批准后实施。本 PR 不改外壳、入口或发送链。

| 文件 | 拟议改动 |
| --- | --- |
| `apps/worker/src/shell/router.ts` | 增加显式退订协议标记（如 `protocol: "unsubscribe"`），只允许 capability 域的 GET/POST `/unsubscribe/*` 与 POST `/email/one-click/*`；写动作仍为 `write: true`。这几个受限能力路由不解析会话、不要求 Origin/CSRF，由 token 决定绑定与列表权限；普通 JSON/API 路由继续原管线。非法域、路径、方法组合失败关闭。日志只记固定路由模板。 |
| `apps/worker/src/shell/body-schema.ts` | 提供有界表单读取：支持 `application/x-www-form-urlencoded` 与 `multipart/form-data`；使用注册表 `API_BODY_MAX_BYTES`，实际流读取也有界；拒绝文件、重复字段、非法编码及结构，沿用 schema 的未知字段/所有权字段检查。one-click 仅接收 `List-Unsubscribe=One-Click`，值的协议校验放退订模块。 |
| `apps/worker/src/shell/headers.ts` | 给外壳安全头函数增加显式 HTML 策略选项，默认仍 CSP_STRICT；仅选中的退订 HTML 响应使用已有 CSP_HTML_SAME_ORIGIN。继续统一覆写安全头，不信任 handler 随意传入的 CSP。保留 no-referrer、nosniff 和严格同源 CORS。 |
| `apps/worker/src/shell/*.test.ts` | 补默认 API 不被放宽、非法协议声明失败关闭、表单大小/畸形/重复/文件/未知字段拒绝、安全头与日志不泄漏 token 的测试。 |

正文确认 POST 同样是 token 授权能力，GET 仅输出确认页；POST 不通过把 `write` 标成 false 来规避管线。
HTML 页面及退订结果应设置 `Cache-Control: no-store`，不加载第三方资源。one-click 不重定向、不设置 Cookie；GET one-click 不产生状态变更。

获准后在本卡原范围完成：复用现有带 key_id 的 MAC 原语，绑定不可变 email_binding_id/list_scope；条件提交关闭当前绑定业务通道；换绑/注销/无效/撤销 token 明确失效；正常轮换保留验证能力；发送可用三项事实接线；模板北京时间和用户可读说明。保留 index.ts 的两组 pauseHooks/lifecycle hooks。

## 价值

标准邮箱客户端可以用表单直接退订，确认页可以真正提交，同时现有会话 API 的保护不变。

## 成本

追加三个外壳实现文件及相应测试；无依赖升级、无迁移、无资源创建。
本 PR 只有提案和四个诊断探针，未启用业务外发，也不改变已发邮件、日历 UID 或地址。

## 安全影响

退订 POST 会成为新的免会话、免 Origin/CSRF 入口；授权必须仅来自验证通过的 MAC 与当前邮箱绑定，不能借 Cookie 指向别的用户。
协议声明必须受限，避免错误接线让普通 user/admin API 免检。表单解析必须有界，日志不可记录路径实值和字段值。
HTML 策略允许同源表单与资源，仅对显式 HTML 路由开启；其他响应保留严格策略。

## 预算与容量影响

本提案不产生发送、持久数据或平台操作。三个邮件日池及 floor 不变（ADR-0003），不恢复旧月池。
复用 API_BODY_MAX_BYTES，无新增参数或 A.5 等式。正式实现仍不逐邮件存 token 行。

## 回退

撤回本提案及诊断文件即可恢复基线。无数据库变更，无已发邮件或其他不可逆效果。
正式退订实现及其回退需在获准后的报告另行给出。

## 备选方案

- `write: false` 冒充读路由：绕过写管线，用户明确禁止。
- index.ts 提前分流到独立 handler：绕过外壳，用户明确禁止。
- 只用 `csrf: false`：实测仍被 JSON 和 Origin 拒绝；也不符合该属性当前的使用范围。
- 要求邮箱客户端发送 JSON/Origin/Cookie：不满足 §7.6 和标准请求合同。
- handler 自设 HTML CSP：实测被统一安全头覆盖。

## 待确认

批准上表外壳范围后再继续 P4-06。当前 A-P4-UNSUB 未交付，不应按功能完成合并此 PR。
真实收件的 DKIM `h=` 覆盖 List-Unsubscribe 与 List-Unsubscribe-Post：**需所有者执行**，本卡不发真实邮件。
