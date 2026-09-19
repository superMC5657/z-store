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
  Tag,
  ArrowLeft,
} from 'lucide-react';
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
  /**
   * Global device-platform filter reset owned by the caller (App).
   * Required: the empty-state reset button always restores the full
   * device set via App and returns to the category hall.
   */
  onResetPlatformFilter: () => void;
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
  onResetPlatformFilter,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  // Single-dimension category filtering over the incoming `apps` prop, which
  // the caller (App) has already filtered by the global device-platform
  // selection. This view MUST NOT apply any platform filtering of its own.
  const filteredApps = React.useMemo(() => {
    if (selectedCategory) {
      return apps.filter(
        (a) => a.category.toLowerCase() === selectedCategory.toLowerCase()
      );
    }
    return [];
  }, [apps, selectedCategory]);

  const currentCategoryMeta = CATEGORY_DEFINITIONS.find((c) => c.id === selectedCategory);

  const handleResetFilter = () => {
    onResetPlatformFilter();
    setSelectedCategory(null);
  };

  return (
    <div className="categories-view view-entrance">
      {/* 顶部标题与返回控制 */}
      <div className="section-header">
        <h3 className="section-title">
          {selectedCategory && currentCategoryMeta ? (
            <>
              <currentCategoryMeta.Icon size={18} style={{ color: currentCategoryMeta.color }} />
              <span>{currentCategoryMeta.name} ({filteredApps.length})</span>
            </>
          ) : (
            <>
              <Tag size={18} />
              <span>按主题领域浏览</span>
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

      {!selectedCategory ? (
        <>
          {apps.length === 0 && (
            <div className="empty-state-card" style={{ marginBottom: '16px', padding: '24px', textAlign: 'center' }}>
              <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                当前设备筛选下暂无收录应用
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '16px' }}>
                侧栏「设备平台」中所选设备组合没有命中任何收录应用。放宽勾选项，或一键恢复全部设备后即可继续浏览分类。
              </div>
              <button className="btn-fluent btn-primary filter-empty-reset" onClick={handleResetFilter}>
                重置设备筛选
              </button>
            </div>
          )}
          <div className="app-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {CATEGORY_DEFINITIONS.map((cat) => {
            const count = apps.filter(
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
        </>
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
              <div style={{ fontSize: '14px', marginBottom: '16px' }}>
                当前分类在所选设备组合下暂无收录应用，试试放宽设备筛选后重新浏览。
              </div>
              <button className="btn-fluent btn-secondary filter-empty-reset" onClick={handleResetFilter}>
                重置设备筛选
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
