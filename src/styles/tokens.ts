/**
 * Design tokens（TS 侧）：需进入数据载荷的样式常量（CSS 变量无法嵌入数据值）。
 * TS 常量是数据载荷的唯一来源；Rust 侧同名常量（见各常量注释）必须与之等值，
 * 由同目录 `tokens.parity.test.ts` 读取 Rust 源码卡点；调用方禁止手写字面渐变。
 */

/**
 * 应用缺省底色渐变（图标占位/未收录兜底的唯一来源）：
 * Rust 侧 `DEFAULT_ICON_BG`（`src-tauri/src/github/http.rs`）须与此等值。
 */
export const DEFAULT_ICON_BG = 'linear-gradient(135deg, #475569, #334155)';
