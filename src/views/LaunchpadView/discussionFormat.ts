import { Marked, type TokenizerAndRendererExtension } from 'marked';
import type { LaunchpadReactionContent } from '../../types';
import { sanitizeHtml } from '../../utils/sanitize';

export type LaunchpadReactionLabelKey =
  | 'launchpad.reaction_thumbs_up'
  | 'launchpad.reaction_thumbs_down'
  | 'launchpad.reaction_laugh'
  | 'launchpad.reaction_hooray'
  | 'launchpad.reaction_confused'
  | 'launchpad.reaction_heart'
  | 'launchpad.reaction_rocket'
  | 'launchpad.reaction_eyes';

/** GitHub Discussions 支持的 8 种标准 Emoji Reaction（顺序与网页端一致）。 */
export const DISCUSSION_REACTIONS: ReadonlyArray<{
  content: LaunchpadReactionContent;
  emoji: string;
  labelKey: LaunchpadReactionLabelKey;
}> = [
  { content: 'THUMBS_UP', emoji: '👍', labelKey: 'launchpad.reaction_thumbs_up' },
  { content: 'THUMBS_DOWN', emoji: '👎', labelKey: 'launchpad.reaction_thumbs_down' },
  { content: 'LAUGH', emoji: '😄', labelKey: 'launchpad.reaction_laugh' },
  { content: 'HOORAY', emoji: '🎉', labelKey: 'launchpad.reaction_hooray' },
  { content: 'CONFUSED', emoji: '😕', labelKey: 'launchpad.reaction_confused' },
  { content: 'HEART', emoji: '❤️', labelKey: 'launchpad.reaction_heart' },
  { content: 'ROCKET', emoji: '🚀', labelKey: 'launchpad.reaction_rocket' },
  { content: 'EYES', emoji: '👀', labelKey: 'launchpad.reaction_eyes' },
];

export function reactionEmoji(content: string): string {
  return DISCUSSION_REACTIONS.find((r) => r.content === content)?.emoji ?? content;
}

/** GitHub 常用 `:shortcode:` → Unicode 表情（仅收录常见项，未知短码原样保留）。 */
export const EMOJI_SHORTCODES: Readonly<Record<string, string>> = {
  '+1': '👍',
  thumbsup: '👍',
  '-1': '👎',
  thumbsdown: '👎',
  smile: '😄',
  smiley: '😃',
  grinning: '😀',
  laughing: '😆',
  joy: '😂',
  wink: '😉',
  blush: '😊',
  heart_eyes: '😍',
  thinking: '🤔',
  sweat_smile: '😅',
  confused: '😕',
  cry: '😢',
  sob: '😭',
  scream: '😱',
  sunglasses: '😎',
  heart: '❤️',
  tada: '🎉',
  rocket: '🚀',
  fire: '🔥',
  star: '⭐',
  sparkles: '✨',
  eyes: '👀',
  clap: '👏',
  pray: '🙏',
  ok_hand: '👌',
  muscle: '💪',
  wave: '👋',
  raised_hands: '🙌',
  bug: '🐛',
  bulb: '💡',
  zap: '⚡',
  warning: '⚠️',
  white_check_mark: '✅',
  x: '❌',
  question: '❓',
  coffee: '☕',
  hammer_and_wrench: '🛠️',
  memo: '📝',
  package: '📦',
  lock: '🔒',
  hundred: '💯',
  '100': '💯',
};

/** 输入框表情面板（与 GitHub 反应 / 常用短码对齐）。 */
export const COMPOSER_EMOJIS: readonly string[] = [
  '👍', '👎', '😄', '😂', '😊', '😍', '🤔', '😅', '😢', '😱', '😎', '🙏',
  '👏', '🙌', '💪', '👋', '👀', '❤️', '🎉', '🚀', '🔥', '⭐', '✨', '💯',
  '💡', '🐛', '⚡', '✅', '❌', '⚠️', '❓', '☕', '🛠️', '📝', '📦', '🔒',
];

const emojiExtension: TokenizerAndRendererExtension = {
  name: 'emojiShortcode',
  level: 'inline',
  start(src: string) {
    const i = src.indexOf(':');
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = /^:([a-z0-9_+-]+):/.exec(src);
    const emoji = m ? EMOJI_SHORTCODES[m[1]] : undefined;
    if (!m || !emoji) return undefined;
    return { type: 'emojiShortcode', raw: m[0], text: emoji };
  },
  renderer(token) {
    return String(token.text ?? '');
  },
};

// 独立实例：GitHub 评论语义（单换行即 <br>）与短码表情，不污染 README 渲染所用的全局 marked。
const discussionMarked = new Marked({ gfm: true, breaks: true });
discussionMarked.use({ extensions: [emojiExtension] });

/** 讨论 Markdown → 净化 HTML（统一经 `sanitizeHtml` 白名单）。 */
export function renderDiscussionMarkdown(body: string): string {
  const text = body?.trim();
  if (!text) return '';
  return sanitizeHtml(discussionMarked.parse(text, { async: false }) as string);
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** 相对时间（“3 小时前” / “3 hours ago”）；不足一分钟按“现在”。 */
export function formatRelativeTime(iso: string, language: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diffSec = Math.round((t - nowMs) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language || undefined, { numeric: 'auto' });
  for (const [unit, secs] of RELATIVE_UNITS) {
    if (Math.abs(diffSec) >= secs) return rtf.format(Math.trunc(diffSec / secs), unit);
  }
  return rtf.format(0, 'second');
}

export type MarkdownFormat = 'bold' | 'italic' | 'code' | 'link' | 'quote' | 'list';

export interface TextEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** 在 `[start, end)` 插入文本并把光标放到插入内容末尾。 */
export function insertText(value: string, start: number, end: number, text: string): TextEdit {
  const next = value.slice(0, start) + text + value.slice(end);
  const caret = start + text.length;
  return { value: next, selectionStart: caret, selectionEnd: caret };
}

/** 工具栏 Markdown 格式化：行内包裹选区，引用 / 列表按行加前缀；无选区时插入占位并选中占位词。 */
export function applyMarkdownFormat(
  value: string,
  start: number,
  end: number,
  format: MarkdownFormat,
  placeholder: string,
): TextEdit {
  const selected = value.slice(start, end);
  const inner = selected || placeholder;
  const wrap = (before: string, after: string): TextEdit => {
    const next = value.slice(0, start) + before + inner + after + value.slice(end);
    const s = start + before.length;
    return { value: next, selectionStart: s, selectionEnd: s + inner.length };
  };
  switch (format) {
    case 'bold':
      return wrap('**', '**');
    case 'italic':
      return wrap('_', '_');
    case 'code':
      return inner.includes('\n') ? wrap('```\n', '\n```') : wrap('`', '`');
    case 'link':
      return wrap('[', '](https://)');
    case 'quote':
    case 'list': {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const block = selected ? value.slice(lineStart, end) : placeholder;
      const prefix = format === 'quote' ? '> ' : '- ';
      const prefixed = block
        .split('\n')
        .map((l) => prefix + l)
        .join('\n');
      const head = selected ? value.slice(0, lineStart) : value.slice(0, start);
      const lead = !selected && head && !head.endsWith('\n') ? '\n' : '';
      const next = head + lead + prefixed + value.slice(end);
      const s = head.length + lead.length;
      return selected
        ? { value: next, selectionStart: s, selectionEnd: s + prefixed.length }
        : { value: next, selectionStart: s + prefix.length, selectionEnd: s + prefixed.length };
    }
  }
}
