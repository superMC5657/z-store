import { describe, expect, it } from 'vitest';
import {
  applyMarkdownFormat,
  formatRelativeTime,
  insertText,
  renderDiscussionMarkdown,
} from './discussionFormat';

describe('applyMarkdownFormat', () => {
  it('行内格式包裹选区并保持选中', () => {
    const r = applyMarkdownFormat('say hello now', 4, 9, 'bold', 'text');
    expect(r.value).toBe('say **hello** now');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('hello');
  });

  it('无选区插入占位词并选中占位', () => {
    const r = applyMarkdownFormat('', 0, 0, 'link', 'link text');
    expect(r.value).toBe('[link text](https://)');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('link text');
  });

  it('多行选区的代码块与列表按行处理', () => {
    expect(applyMarkdownFormat('a\nb', 0, 3, 'code', 'code').value).toBe('```\na\nb\n```');
    expect(applyMarkdownFormat('x\na\nb', 2, 5, 'list', 'text').value).toBe('x\n- a\n- b');
    expect(applyMarkdownFormat('para', 4, 4, 'quote', 'text').value).toBe('para\n> text');
  });

  it('insertText 光标落在插入内容末尾', () => {
    expect(insertText('ab', 1, 1, '🎉')).toEqual({ value: 'a🎉b', selectionStart: 3, selectionEnd: 3 });
  });
});

describe('renderDiscussionMarkdown', () => {
  it('单换行转 <br>，已知短码转表情，代码中的短码与未知短码保持原样', () => {
    const html = renderDiscussionMarkdown('line1\nline2 :+1: `:+1:` :not_a_code:');
    expect(html).toContain('<br');
    expect(html).toContain('👍');
    expect(html).toContain('<code>:+1:</code>');
    expect(html).toContain(':not_a_code:');
  });

  it('净化危险标签', () => {
    const html = renderDiscussionMarkdown('<img src=x onerror="alert(1)"><script>x</script>');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  it('按最大单位输出相对时间', () => {
    expect(formatRelativeTime('2026-11-17T09:00:00Z', 'en-US', now)).toBe('3 hours ago');
    expect(formatRelativeTime('2026-11-16T12:00:00Z', 'en-US', now)).toBe('yesterday');
    expect(formatRelativeTime('2026-11-17T11:59:40Z', 'en-US', now)).toBe('now');
    expect(formatRelativeTime('bad', 'en-US', now)).toBe('');
  });
});
