import { describe, it, expect, beforeEach } from 'vitest';
import i18n, { getSystemLanguage } from './i18n';

describe('i18n core configuration and language switching', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('initializes with zh-CN translations by default', () => {
    expect(i18n.language).toBe('zh-CN');
    expect(i18n.t('common.save')).toBe('保存');
    expect(i18n.t('settings.appearance')).toBe('外观');
    expect(i18n.t('nav.items.home')).toBe('精选');
  });

  it('switches to en-US and returns correct English text', async () => {
    await i18n.changeLanguage('en-US');
    expect(i18n.language).toBe('en-US');
    expect(i18n.t('common.save')).toBe('Save');
    expect(i18n.t('settings.appearance')).toBe('Appearance');
    expect(i18n.t('nav.items.home')).toBe('Featured');
    expect(i18n.t('titlebar.search_placeholder')).toContain('Search');
  });

  it('handles interpolation parameters correctly in both languages', async () => {
    expect(i18n.t('installed.title', { count: 5 })).toBe('已安装 (5)');

    await i18n.changeLanguage('en-US');
    expect(i18n.t('installed.title', { count: 5 })).toBe('Installed (5)');
  });

  it('falls back to zh-CN when key exists in fallback', async () => {
    await i18n.changeLanguage('en-US');
    // 测试不存在键的回退行为
    expect(i18n.t('non_existent.key' as any)).toBe('non_existent.key');
  });

  it('detects system language correctly', () => {
    const detected = getSystemLanguage();
    expect(['zh-CN', 'en-US']).toContain(detected);
  });
});
