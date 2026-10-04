import type { GameId } from "@hoyo/contracts";

/**
 * 官方游戏应用图标（ADR-0015）：取自米游社公开游戏列表的 app_icon，2026-10-05 下载并缩到 96×96，
 * 随站点静态资源发布，页面不向官方请求图片。版权归米哈游，只用于标识游戏；
 * 始终与游戏名称一起出现，本身对读屏隐藏。
 */
export const GAME_ICON_SRC: Record<GameId, string> = {
  genshin: "/game-icons/genshin.png",
  hsr: "/game-icons/hsr.png",
  zzz: "/game-icons/zzz.png",
};
/** 图标文件的固有尺寸（像素）；显示尺寸由 .game-icon 的修饰类决定。 */
export const GAME_ICON_SIZE = 96;

/** 窄屏筛选胶囊上的简称；完整名称仍是控件的可访问名称。 */
export const GAME_SHORT_NAMES: Record<GameId, string> = {
  genshin: "原神",
  hsr: "星铁",
  zzz: "绝区零",
};

export function gameIcon(game: GameId, className = "game-icon"): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = className;
  wrap.dataset.game = game;
  wrap.setAttribute("aria-hidden", "true");
  const image = document.createElement("img");
  image.src = GAME_ICON_SRC[game];
  image.alt = "";
  image.width = GAME_ICON_SIZE;
  image.height = GAME_ICON_SIZE;
  image.decoding = "async";
  wrap.append(image);
  return wrap;
}
