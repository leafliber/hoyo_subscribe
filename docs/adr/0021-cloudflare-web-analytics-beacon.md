# ADR-0021：允许 Cloudflare Web Analytics 在全站（含认证与退订页面）自动注入统计信标

- **状态**：已接受（所有者 2026-10-06 决定；无代码改动）
- **日期**：2026-10-06
- **提出者**：验收方（2026-10-06 文档整理时发现），所有者决定
- **需要所有者批准**：是，已批准。所有者 2026-10-06 原话："修订为允许"；范围选"全站允许，含退订页"。
- **与已有规则的关系**：修订主方案 §8.3 中"认证和退订页面不加载第三方追踪代码"一句；为 AGENTS.md 硬规则 7"秘密不进遥测"开一个只限本信标的例外。

## 背景

2026-10-06 验收方以浏览器 UA（`Accept: text/html`）只读请求正式站点：首页、`/login/`、`/account/` 和一个无效 token 的 `/unsubscribe/…`，返回的 HTML 里都有 `<script … src="https://static.cloudflareinsights.com/beacon.min.js/…">`。用 curl 默认请求头请求时看不到这个脚本。

- 来源：airo.cc 区域开启了 Web Analytics（Real User Monitoring）自动注入，由 Cloudflare 边缘在 HTML 响应里插入。站点自身代码和构建产物都没有引入它。
- 免费套餐的 Web Analytics 规则额度为 0，注入覆盖区域下的全部子域（Cloudflare 文档 Web Analytics › Limits，2026-10-06 查）。
- 冲突的原文：
  - 主方案 §8.3："使用 CSP、no-referrer、严格同源 CORS；认证和退订页面不加载第三方追踪代码。"
  - AGENTS.md 硬规则 7："秘密不进仓库、不进日志、不进前端产物、不进遥测、不进截图。包括 Cookie、OTP、恢复码、完整邮箱、Feed/退订 URL、Push endpoint 与密钥。"

信标采集的内容（Cloudflare 文档 Web Analytics › Core Web Vitals、FAQ，2026-10-06 查）：

- 不使用 Cookie、`localStorage` 等客户端状态，不按 IP 或 UA 做指纹；
- 采集页面路径与性能指标（Core Web Vitals 等），在页面加载完成和离开页面时向本站的 `/cdn-cgi/rum/` 上报。

所以退订页 `/unsubscribe/{token}` 的路径——包括退订 token——会进入 Cloudflare 的 Web Analytics 数据。个人 Feed（`.ics`）和 one-click 退订（邮件客户端直接 POST，不渲染 HTML）不受影响。

## 受影响的合同

| 文档 | 章节 | 现有规定 | 本 ADR |
| --- | --- | --- | --- |
| 主方案 | §8.3 安全、秘密与日志 | 认证和退订页面不加载第三方追踪代码 | 允许 Cloudflare 边缘自动注入的 Web Analytics 信标出现在全部页面，含认证与退订页面；站点自身代码与构建产物仍不引入任何第三方追踪代码 |
| AGENTS.md | 硬规则 7 | 退订 URL 等不进遥测 | 例外：上述信标上报的页面路径（含退订页路径里的 token）。站点自身的日志、指标、错误上下文、截图仍不得包含这些值 |
| 任务卡与验收 | A-F1-POLISH、A-P3-ARTICLE-VIEW 等"页面不向第三方请求"的表述 | — | 指站点自身代码与构建产物；边缘注入的信标不在其内。本地与 CI 的 E2E 跑在不经 Cloudflare 边缘的构建上，照旧断言零第三方请求 |

## 决策

1. 保持区域的 Web Analytics 自动注入开启，全站都允许，包括 `/login/`、`/account/`、`/recover/` 与 `/unsubscribe/*`。
2. 站点自身代码、构建产物和 Worker 生成的页面仍不主动引入任何第三方脚本，E2E 继续断言零第三方请求。
3. 以后收紧 CSP 的 `script-src` / `connect-src` 时，要同时放行 `static.cloudflareinsights.com` 与本站 `/cdn-cgi/rum/`；不放行就等于撤回本 ADR，须在本文登记。
4. 硬规则 7 的例外只限这个信标。不得据此在站点代码里上报或记录退订 URL、Feed URL 或任何其他秘密。

## 价值

所有者能在 Cloudflare 面板看到各页面的访问量与性能（Core Web Vitals），不用自建统计，不新增计量项或费用。

## 成本

无代码改动、无迁移、无重新部署。每个 HTML 页面多加载一个由 Cloudflare 托管的小脚本，并在加载完成、离开页面时各上报一次。

## 安全影响

- **数据接收方没有增加**：本站整体托管在 Cloudflare，边缘本来就能看到每个请求的路径（区域的 HTTP 分析里已有按路径的统计）。信标把页面路径与性能数据在 Web Analytics 里另存一份。
- **退订 token 进入统计面板**：能打开该账户 Web Analytics 面板的人可以看到退订页路径里的 token，并能用它退订对应地址的业务邮件。退订 token 的能力边界不变：只能关闭对应地址的业务邮件，不读写账号（`CONTRACTS_BASELINE.md` §2）。
- **认证页面里运行第三方脚本**：信标运行在登录、恢复、账号页面的上下文里，理论上能读到页面上的输入（验证码、恢复码）。脚本由 Cloudflare 托管，注入的标签带 SRI（`integrity`）；所有者接受这一信任边界，理由同上：本站已整体信任 Cloudflare 边缘。
- **Referer**：静态页面对跨源请求只带来源（ADR-0022），信标脚本请求看不到页面路径；但信标自己会上报路径。

## 预算与容量影响

无。Web Analytics 不计费，不影响邮件池、模型日预算、账号存量与 D1。

## 回退

- 在区域关闭 Web Analytics 自动注入；或用区域的 Configuration Rules 里「Disable Real User Monitoring (RUM)」按路径关闭（免费套餐不能用 Web Analytics 自带的规则排除路径）。
- 已经上报的数据留在 Cloudflare Web Analytics 里，按其保留期过期，本站无法删除。

## 备选方案

1. **全站允许，但用 Configuration Rules 关掉 `/unsubscribe/*` 的 RUM**：退订 token 不进统计，硬规则 7 不用开例外。所有者选择全站允许。
2. **关闭自动注入，回到 §8.3 原文**：失去访问与性能统计。

## 待确认

无。
