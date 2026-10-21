/**
 * Design tokens（TS 侧）：需进入数据载荷的样式常量（CSS 变量无法嵌入数据值），
 * 视觉规范与同目录 `tokens.css` 同源维护。
 */

/**
 * 应用缺省底色渐变（图标占位/未收录兜底的唯一来源）：
 * 与 Rust 侧 `DEFAULT_ICON_BG`（`src-tauri/src/github/http.rs`）同值互指；
 * 调用方禁止再手写字面渐变。
 */
export const DEFAULT_ICON_BG = 'linear-gradient(135deg, #475569, #334155)';
