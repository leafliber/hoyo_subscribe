// 构建期生成固定路径的 /mail-page.css，供 Worker 输出的退订确认页引用。
// 由 tokens.css 与 mail-page.css 拼接而成，颜色仍只在 tokens.css 定义。
import mailPage from "../styles/mail-page.css?raw";
import tokens from "../styles/tokens.css?raw";

export function GET(): Response {
  return new Response(`${tokens}\n${mailPage}`, {
    headers: { "content-type": "text/css; charset=utf-8" },
  });
}
