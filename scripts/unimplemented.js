#!/usr/bin/env node
// P1-01 占位：ENGINEERING.md §3 的脚本在对应任务卡交付前，一律以非零退出并打印"未实现"，不得假成功。
const target = process.argv.slice(2).join(" ").trim() || "(未指定脚本名)";
console.error(`未实现：${target}`);
console.error("该脚本由后续任务卡交付；在此之前本命令恒以退出码 1 结束。");
process.exit(1);
