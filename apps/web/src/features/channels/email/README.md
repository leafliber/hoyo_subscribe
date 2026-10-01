# 邮件提醒

正式订阅页通过 `EmailChannelLifecycle` 挂载两层邮件组件。身份事件和保存状态机的快照必须同时确认；
身份未知、退出、切换或页面生命周期失效时销毁实例，旧请求不能更新新账号视图。

- `api.ts` 读取事实和操作结果，不用缺字段制造已启用或正常状态。
- `panel.ts` 调用 contracts 的 `emailChannelEnableAvailability`，以闭合 `EmailChannelBlockReason`
  和写入错误的 `blocked_reason` 给反馈。容量上限来自注册表；日限频、租期和同意版本来自服务端 disclosure。
- 每次开启先读取当前已保存摘要，分别确认两层同意。版本冲突或校验失败要求重新确认，不自动重发。
  部分完成、未知结果、发送暂停与抑制分别显示。
- `subscription.ts` 复用 F2-03 / F2-04 的保存与草稿生命周期，邮件状态和同意不进入订阅 JSON 或本机存储。
- 页面保存新版本后刷新邮件状态；GET 和成功 PUT 都核对已确认订阅版本。
  迟到 PUT 保留操作回执中的完成事实，旧快照不作为当前状态；提供重读入口，不自动重发或沿用同意。
- 当前身份下 completed / partial 的已完成操作发起一次显式会话续期 POST，由后端判断间隔。
  加载、GET、失败/未确认或被身份变化丢弃的结果不续期；续期失败不改变邮件操作结果。
- 后台续租状态仍按接口呈现，不把登录、偏好导入或订阅保存当作邮件同意。

标准浏览器验收位于 `tests/e2e/email.spec.ts`，运行 `pnpm test:e2e` 会自动收集。
用例访问静态构建的 `/subscription`，只对 API 使用合成事实，不注入 HTML 或开发态模块。
截图默认写入忽略的测试结果目录；只有显式设置 `HOYO_E2E_WRITE_EVIDENCE=1` 才更新
`tests/e2e/evidence/f4-01/`。不连接真实发送链。
