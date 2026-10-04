import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
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
import {
  FilterEmptyState,
  RequiredPlatformReset,
  ViewAppActions,
  ViewShell,
} from './ViewShell';

interface CategoriesViewProps extends ViewAppActions, RequiredPlatformReset {
  platformResolvedOtherIds?: ReadonlySet<string>;
}

const CATEGORY_DEFINITIONS = [
  { id: 'dev', Icon: Code2, nameKey: 'categories.cat_dev_name' as const, descKey: 'categories.cat_dev_desc' as const, color: '#5865f2' },
  { id: 'media', Icon: Music, nameKey: 'categories.cat_media_name' as const, descKey: 'categories.cat_media_desc' as const, color: '#ec4899' },
  { id: 'office', Icon: FileText, nameKey: 'categories.cat_office_name' as const, descKey: 'categories.cat_office_desc' as const, color: '#8b5cf6' },
  { id: 'security', Icon: ShieldCheck, nameKey: 'categories.cat_security_name' as const, descKey: 'categories.cat_security_desc' as const, color: '#10b981' },
  { id: 'graphics', Icon: Palette, nameKey: 'categories.cat_graphics_name' as const, descKey: 'categories.cat_graphics_desc' as const, color: '#f59e0b' },
  { id: 'network', Icon: Network, nameKey: 'categories.cat_network_name' as const, descKey: 'categories.cat_network_desc' as const, color: '#3b82f6' },
  { id: 'system', Icon: Cpu, nameKey: 'categories.cat_system_name' as const, descKey: 'categories.cat_system_desc' as const, color: '#6366f1' },
  { id: 'reading', Icon: BookOpen, nameKey: 'categories.cat_reading_name' as const, descKey: 'categories.cat_reading_desc' as const, color: '#14b8a6' },
  { id: 'ops', Icon: Terminal, nameKey: 'categories.cat_ops_name' as const, descKey: 'categories.cat_ops_desc' as const, color: '#f97316' },
  { id: 'games', Icon: Gamepad2, nameKey: 'categories.cat_games_name' as const, descKey: 'categories.cat_games_desc' as const, color: '#a855f7' },
];

export const CategoriesView: React.FC<CategoriesViewProps> = ({
  apps,
  platformResolvedOtherIds,
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
  const { t } = useTranslation();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const isPending = (a: { id: string; platforms?: string[] }): boolean => {
    if (a.platforms && a.platforms.length > 0) return false;
    if (!platformResolvedOtherIds) return false;
    return !platformResolvedOtherIds.has(a.id.toLowerCase());
  };

  // 对传入的 `apps` 属性进行单维度分类过滤；
  // 调用方（App）已按全局设备平台选择进行了预过滤。本视图绝不自行做二次平台过滤。
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
    <ViewShell viewClass="categories-view">
      {/* 顶部标题与返回控制 */}
      <div className="section-header">
        <h3 className="section-title">
          {selectedCategory && currentCategoryMeta ? (
            <>
              <currentCategoryMeta.Icon size={18} style={{ color: currentCategoryMeta.color }} />
              <span>{t(currentCategoryMeta.nameKey)} ({filteredApps.length})</span>
            </>
          ) : (
            <>
              <Tag size={18} />
              <span>{t('categories.title')}</span>
            </>
          )}
        </h3>
        {selectedCategory && (
          <button
            className="btn-fluent btn-sm btn-secondary"
            onClick={() => setSelectedCategory(null)}
            style={{ gap: '6px' }}
          >
            <ArrowLeft size={13} />
            <span>{t('categories.back_to_hall')}</span>
          </button>
        )}
      </div>

      {!selectedCategory ? (
        <>
          {apps.length === 0 && (
            <FilterEmptyState
              style={{ marginBottom: '16px' }}
              title={t('categories.no_apps_device_filter')}
              description={t('categories.no_apps_device_filter_desc')}
              resetLabel={t('categories.reset_device_filter')}
              onReset={handleResetFilter}
            />
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
                  padding: '20px 16px',
                  cursor: 'pointer',
                  opacity: count === 0 ? 0.6 : 1,
                }}
                onClick={() => setSelectedCategory(cat.id)}
              >
                <div
                  style={{
                    width: '44px',
                    height: '44px',
                    borderRadius: 'var(--radius-sm)',
                    background: `color-mix(in srgb, ${cat.color} 12%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${cat.color} 25%, transparent)`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: '10px',
                  }}
                >
                  <cat.Icon size={20} color={cat.color} strokeWidth={1.5} />
                </div>
                <div style={{ fontWeight: 590, fontSize: 'calc(15px * var(--font-scale))', color: 'var(--text-primary)', letterSpacing: '-0.015em' }}>{t(cat.nameKey)}</div>
                <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-tertiary)', marginTop: '4px', lineHeight: '1.4' }}>{t(cat.descKey)}</div>
                <div
                  style={{
                    fontSize: 'var(--font-xs)',
                    marginTop: '10px',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-xs)',
                    background: `color-mix(in srgb, ${cat.color} 10%, transparent)`,
                    color: cat.color,
                    fontWeight: 510,
                    border: `1px solid color-mix(in srgb, ${cat.color} 20%, transparent)`,
                  }}
                >
                  {count > 0 ? t('categories.apps_available', { count }) : t('categories.no_apps_for_platform')}
                </div>
              </div>
            );
          })}
          </div>
        </>
      ) : (
        <div className="app-grid">
          {filteredApps.length > 0 ? (
            filteredApps.map((app, index) => (
              <AppCard
                key={app.id}
                app={app}
                eager={index < 6}
                platformPending={isPending(app)}
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
            <FilterEmptyState
              style={{ width: '100%' }}
              title={t('categories.category_empty_for_platform')}
              resetLabel={t('categories.reset_device_filter')}
              variant="secondary"
              onReset={handleResetFilter}
            />
          )}
        </div>
      )}
    </ViewShell>
  );
};
