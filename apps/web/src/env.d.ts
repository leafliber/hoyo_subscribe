// Vite 的 ?raw 导入（构建期把文件内容作为字符串读入）。
declare module "*?raw" {
  const content: string;
  export default content;
}
