// @ts-check
import { defineConfig } from "astro/config";

// 静态输出：纯静态骨架 + 原生 TS 模块（前端 v1.0 §12.1），
// 不引入 SSR / 服务端依赖；apps/web 不持有任何秘密。
export default defineConfig({
  output: "static",
});
