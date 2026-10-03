type PageState = "confirm" | "closed" | "stale" | "invalid";

const content: Record<PageState, { title: string; description: string }> = {
  confirm: {
    title: "关闭业务邮件",
    description:
      "确认后，将关闭此邮箱的常规提醒，以及取消、撤回、重要更正和晚发现等业务邮件。仅打开此页面不会退订。",
  },
  closed: {
    title: "业务邮件已关闭",
    description: "此邮箱绑定的当前业务邮件已关闭，无需重复操作。",
  },
  stale: {
    title: "旧绑定已失效",
    description:
      "此链接不适用于当前邮箱，当前邮箱的邮件设置未被更改。如需退订，请使用当前邮箱收到的业务邮件中的退订链接。",
  },
  invalid: {
    title: "退订链接已失效",
    description: "此链接无法用于退订，邮件设置未被更改。请使用收到的其他业务邮件中的退订链接。",
  },
};

/** 固定文案，无脚本/外部资源；不回显邮箱、token 或表单 action。 */
export function unsubscribePage(state: PageState): Response {
  const { title, description } = content[state];
  const current = state === "confirm" || state === "closed";
  return new Response(
    `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/mail-page.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${title} · HoYo日历</title>
</head>
<body>
<header><p>HoYo日历 · 邮件退订</p></header>
<main>
<div class="mail-card">
<h1>${title}</h1>
<p>${description}</p>
${current ? '<p class="mail-note">日历订阅、浏览器通知（Push）、账号和验证码邮件不受影响。</p>' : ""}
${state === "confirm" ? '<form method="post"><button type="submit" name="confirm" value="unsubscribe">关闭此邮箱的业务邮件</button></form>' : ""}
<p class="mail-links"><a href="/subscription">管理我的订阅</a> · <a href="/">查看活动日程</a></p>
</div>
</main>
</body>
</html>`,
    {
      status: current ? 200 : 410,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}
