import React, { useState } from 'react';
import {
  Code2,
  Music,
  FileText,
  ShieldCheck,
  Palette,
  Network,
  Cpu,
  BookOpen,
  Terminal,
  Gamepad2,
  Monitor,
  Tag,
  ArrowLeft,
  ArrowRight,
} from 'lucide-react';
import { PlatformIcon } from '../components/icons/PlatformIcons';
import { AppCard } from '../components/AppCard';
import { AppSummary } from '../types';

interface CategoriesViewProps {
  apps: AppSummary[];
  installedIds: Set<string>;
  installingIds?: Set<string>;
  favoriteIds: Set<string>;
  watchedIds?: Set<string>;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onToggleWatch?: (id: string) => void;
}

const CATEGORY_DEFINITIONS = [
  { id: 'dev', Icon: Code2, name: '开发工具', desc: 'IDE, 编辑器, 调试台, 版本控制', color: '#5865f2' },
  { id: 'media', Icon: Music, name: '影音视听', desc: '全能播放器, 录屏推流, 视频压制', color: '#ec4899' },
  { id: 'office', Icon: FileText, name: '效率办公', desc: '双链笔记, Markdown, 知识图谱', color: '#8b5cf6' },
  { id: 'security', Icon: ShieldCheck, name: '安全隐私', desc: '密码管理器, 网络抓包, 隐私保护', color: '#10b981' },
  { id: 'graphics', Icon: Palette, name: '图形设计', desc: '3D 建模, 屏幕截图, 矢量绘图', color: '#f59e0b' },
  { id: 'network', Icon: Network, name: '网络工具', desc: '局域网快传, 规则分流, P2P 下载', color: '#3b82f6' },
  { id: 'system', Icon: Cpu, name: '系统实用', desc: '远程桌面, 效率启动器, 空格预览', color: '#6366f1' },
  { id: 'reading', Icon: BookOpen, name: '学习阅读', desc: 'EPUB 阅读器, 书库管理, 电子书', color: '#14b8a6' },
  { id: 'ops', Icon: Terminal, name: '极客运维', desc: 'GPU 终端, 极客编辑器, 容器平台', color: '#f97316' },
  { id: 'games', Icon: Gamepad2, name: '休闲游戏', desc: '复古模拟器, 模拟经营, 像素沙盒', color: '#a855f7' },
];

const PLATFORM_OPTIONS = [
  { id: 'all', label: '全部设备', platform: null },
  { id: 'windows', label: 'Windows', platform: 'windows' },
  { id: 'android', label: 'Android', platform: 'android' },
  { id: 'macos', label: 'macOS', platform: 'macos' },
  { id: 'linux', label: 'Linux', platform: 'linux' },
  { id: 'ios', label: 'iOS', platform: 'ios' },
];

function matchPlatform(app: AppSummary, platform: string): boolean {
  if (platform === 'all') return true;
  if (!app.platforms || app.platforms.length === 0) {
    return platform === 'windows';
  }
  return app.platforms.some((p) => p.toLowerCase() === platform.toLowerCase());
}

export const CategoriesView: React.FC<CategoriesViewProps> = ({
  apps,
  installedIds,
  installingIds,
  favoriteIds,
  watchedIds,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
  onToggleWatch,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<string>('all');

  // 计算各平台的收录总数
  const platformCounts = React.useMemo(() => {
    const counts: Record<string, number> = { all: apps.length };
    for (const opt of PLATFORM_OPTIONS) {
      if (opt.id === 'all') continue;
      counts[opt.id] = apps.filter((a) => matchPlatform(a, opt.id)).length;
    }
    return counts;
  }, [apps]);

  // 符合当前平台筛选的应用集合
  const platformFilteredApps = React.useMemo(() => {
    return apps.filter((a) => matchPlatform(a, selectedPlatform));
  }, [apps, selectedPlatform]);

  // 符合当前分类与平台双重筛选的应用列表
  const filteredApps = React.useMemo(() => {
    if (selectedCategory === 'all_apps') {
      return platformFilteredApps;
    }
    if (selectedCategory) {
      return platformFilteredApps.filter(
        (a) => a.category.toLowerCase() === selectedCategory.toLowerCase()
      );
    }
    return [];
  }, [platformFilteredApps, selectedCategory]);

  const currentCategoryMeta = CATEGORY_DEFINITIONS.find((c) => c.id === selectedCategory);
  const currentPlatformMeta = PLATFORM_OPTIONS.find((p) => p.id === selectedPlatform) || PLATFORM_OPTIONS[0];

  return (
    <div className="categories-view view-entrance">
      {/* 顶部标题与返回控制 */}
      <div className="section-header">
        <h3 className="section-title">
          {selectedCategory === 'all_apps' ? (
            <>
              {currentPlatformMeta.platform ? (
                <PlatformIcon platform={currentPlatformMeta.platform} size={18} />
              ) : (
                <Monitor size={18} />
              )}
              <span>全部 {currentPlatformMeta.label} 应用 ({filteredApps.length})</span>
            </>
          ) : selectedCategory && currentCategoryMeta ? (
            <>
              <currentCategoryMeta.Icon size={18} style={{ color: currentCategoryMeta.color }} />
              <span>{currentCategoryMeta.name}{selectedPlatform !== 'all' ? ` · ${currentPlatformMeta.label}` : ''} ({filteredApps.length})</span>
            </>
          ) : (
            <>
              <Tag size={18} />
              <span>按主题领域与设备平台浏览</span>
            </>
          )}
        </h3>
        {selectedCategory && (
          <button
            className="btn-fluent btn-secondary"
            onClick={() => setSelectedCategory(null)}
            style={{ fontSize: '12px', padding: '4px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <ArrowLeft size={13} />
            <span>返回分类大厅</span>
          </button>
        )}
      </div>

      {/* 支持设备平台筛选胶囊栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          marginBottom: '20px',
        }}
      >
        <span style={{ fontSize: '13px', color: 'var(--text-secondary)', marginRight: '4px', fontWeight: 600 }}>
          支持设备:
        </span>
        {PLATFORM_OPTIONS.map((opt) => {
          const isActive = selectedPlatform === opt.id;
          const count = platformCounts[opt.id] ?? 0;
          return (
            <button
              key={opt.id}
              onClick={() => setSelectedPlatform(opt.id)}
              className="btn-fluent"
              style={{
                borderRadius: '20px',
                padding: '6px 14px',
                fontSize: '12px',
                fontWeight: isActive ? 600 : 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                background: isActive ? 'var(--brand-primary)' : 'var(--fill-control-subtle)',
                color: isActive ? '#ffffff' : 'var(--text-primary)',
                borderColor: isActive ? 'var(--brand-primary)' : 'var(--border-control)',
                boxShadow: isActive ? '0 2px 8px rgba(0, 120, 212, 0.25)' : 'none',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {opt.platform ? (
                <PlatformIcon platform={opt.platform} size={13} />
              ) : (
                <Monitor size={13} />
              )}
              <span>{opt.label}</span>
              <span
                style={{
                  fontSize: '11px',
                  padding: '1px 6px',
                  borderRadius: '10px',
                  background: isActive ? 'rgba(255, 255, 255, 0.25)' : 'var(--border-subtle)',
                  color: isActive ? '#ffffff' : 'var(--text-tertiary)',
                  marginLeft: '2px',
                }}
              >
                {count}
              </span>
            </button>
          );
        })}

        {/* 当处于未展开具体分类且选择了特定平台时，提供“查看该平台全部应用”按钮 */}
        {!selectedCategory && selectedPlatform !== 'all' && (
          <button
            className="btn-fluent btn-secondary"
            onClick={() => setSelectedCategory('all_apps')}
            style={{
              borderRadius: '20px',
              padding: '6px 14px',
              fontSize: '12px',
              fontWeight: 600,
              marginLeft: 'auto',
              color: 'var(--brand-primary)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span>直接查看全部 {platformFilteredApps.length} 款 {currentPlatformMeta.label} 应用</span>
            <ArrowRight size={13} />
          </button>
        )}
      </div>

      {!selectedCategory ? (
        <div className="app-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {CATEGORY_DEFINITIONS.map((cat) => {
            const count = platformFilteredApps.filter(
              (a) => a.category.toLowerCase() === cat.id.toLowerCase()
            ).length;
            return (
              <div
                key={cat.id}
                className="app-card"
                style={{
                  alignItems: 'center',
                  textAlign: 'center',
                  padding: '22px 16px',
                  cursor: 'pointer',
                  opacity: count === 0 ? 0.6 : 1,
                }}
                onClick={() => setSelectedCategory(cat.id)}
              >
                <div
                  style={{
                    width: '52px',
                    height: '52px',
                    borderRadius: 'var(--radius-md)',
                    background: `color-mix(in srgb, ${cat.color} 15%, transparent)`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: '10px',
                    boxShadow: `0 4px 12px color-mix(in srgb, ${cat.color} 20%, transparent)`,
                  }}
                >
                  <cat.Icon size={24} color={cat.color} />
                </div>
                <div style={{ fontWeight: 600, fontSize: '15px', color: 'var(--text-primary)' }}>{cat.name}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '4px', lineHeight: '1.4' }}>{cat.desc}</div>
                <div
                  style={{
                    fontSize: '11px',
                    marginTop: '12px',
                    padding: '2px 8px',
                    borderRadius: '10px',
                    background: `color-mix(in srgb, ${cat.color} 12%, transparent)`,
                    color: cat.color,
                    fontWeight: 600,
                  }}
                >
                  {count > 0 ? `${count} 款可用` : '暂无此端应用'}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="app-grid">
          {filteredApps.length > 0 ? (
            filteredApps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                isInstalled={installedIds.has(app.id)}
                isInstalling={installingIds?.has(app.id)}
                isFavorite={favoriteIds.has(app.id)}
                isWatched={watchedIds?.has(app.id)}
                onOpenDetail={onOpenDetail}
                onQuickInstall={onQuickInstall}
                onToggleFavorite={onToggleFavorite}
                onToggleWatch={onToggleWatch}
              />
            ))
          ) : (
            <div style={{ color: 'var(--text-tertiary)', padding: '32px', textAlign: 'center', width: '100%' }}>
              当前分类在所选设备平台（{currentPlatformMeta.label}）下暂无收录应用。
            </div>
          )}
        </div>
      )}
    </div>
  );
};
