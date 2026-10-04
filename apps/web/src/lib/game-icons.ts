import type { GameId } from "@hoyo/contracts";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 站内原创的游戏标识（不是官方图标）：白色图形叠在游戏色圆角块上，
 * 始终与游戏名称一起出现，本身对读屏隐藏。只含常量路径，不含外部数据。
 * 原神：大小两颗星芒；崩坏：星穹铁道：列车正面；绝区零：Zz。
 */
export const GAME_GLYPHS: Record<GameId, string> = {
  genshin:
    '<path fill="currentColor" d="M10.6 5C11.58 12.22 11.58 12.22 18.8 13.2C11.58 14.18 11.58 14.18 10.6 21.4C9.62 14.18 9.62 14.18 2.4 13.2C9.62 12.22 9.62 12.22 10.6 5Z"/><path fill="currentColor" d="M18.6 2.2C18.98 5.02 18.98 5.02 21.8 5.4C18.98 5.78 18.98 5.78 18.6 8.6C18.22 5.78 18.22 5.78 15.4 5.4C18.22 5.02 18.22 5.02 18.6 2.2Z"/>',
  hsr: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3.5" width="12" height="13.5" rx="3.2"/><path d="M6 10h12M9 20.5l1.4-3.5M15 20.5l-1.4-3.5"/></g><circle cx="9.2" cy="13.6" r="1.1" fill="currentColor"/><circle cx="14.8" cy="13.6" r="1.1" fill="currentColor"/>',
  zzz: '<g fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path stroke-width="2.5" d="M4.5 9.5h8.6l-8.6 9.5h8.6"/><path stroke-width="2.1" d="M14.8 4.5h5l-5 5.5h5"/></g>',
};

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
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("focusable", "false");
  // 常量路径，不含任何外部字符串。
  svg.innerHTML = GAME_GLYPHS[game];
  wrap.append(svg);
  return wrap;
}
