// params:docs CLI（任务卡 P1-03）：从参数注册表导出附录 A 文档表格，保证文档与运行参数同源。
//
// 用法：pnpm params:docs（package.json → tsx scripts/params/export-docs.ts）
// 产物：docs/APPENDIX_A.generated.md（生成物，勿手改；contracts 测试会比对，防漂移）。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildAppendixMarkdown } from "../../packages/contracts/src/index.ts";

const target = resolve(import.meta.dirname, "../../docs/APPENDIX_A.generated.md");
const content = buildAppendixMarkdown();
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, content, "utf8");
console.log(
  `已生成 ${target}（${content.split("\n").length} 行）——请提交该文件以保持文档与注册表同源。`,
);
