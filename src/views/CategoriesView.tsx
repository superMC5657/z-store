import React, { useState } from 'react';
import { AppCard } from '../components/AppCard';
import { AppSummary } from '../types';

interface CategoriesViewProps {
  apps: AppSummary[];
  installedIds: Set<string>;
  favoriteIds: Set<string>;
  onOpenDetail: (id: string) => void;
  onQuickInstall: (id: string) => void;
  onToggleFavorite: (id: string) => void;
}

const CATEGORY_DEFINITIONS = [
  { id: 'dev', icon: '💻', name: '开发工具', desc: 'IDE, 编辑器, 调试台, 版本控制', color: '#5865f2' },
  { id: 'media', icon: '🎵', name: '影音视听', desc: '全能播放器, 录屏推流, 视频压制', color: '#ec4899' },
  { id: 'office', icon: '📑', name: '效率办公', desc: '双链笔记, Markdown, 知识图谱', color: '#8b5cf6' },
  { id: 'security', icon: '🛡️', name: '安全隐私', desc: '密码管理器, 网络抓包, 隐私保护', color: '#10b981' },
  { id: 'graphics', icon: '🎨', name: '图形设计', desc: '3D 建模, 屏幕截图, 矢量绘图', color: '#f59e0b' },
  { id: 'network', icon: '🌐', name: '网络工具', desc: '局域网快传, 规则分流, P2P 下载', color: '#3b82f6' },
  { id: 'system', icon: '⚙️', name: '系统实用', desc: '远程桌面, 效率启动器, 空格预览', color: '#6366f1' },
  { id: 'reading', icon: '📖', name: '学习阅读', desc: 'EPUB 阅读器, 书库管理, 电子书', color: '#14b8a6' },
  { id: 'ops', icon: '🚀', name: '极客运维', desc: 'GPU 终端, 极客编辑器, 容器平台', color: '#f97316' },
  { id: 'games', icon: '🎮', name: '休闲游戏', desc: '复古模拟器, 模拟经营, 像素沙盒', color: '#a855f7' },
];

export const CategoriesView: React.FC<CategoriesViewProps> = ({
  apps,
  installedIds,
  favoriteIds,
  onOpenDetail,
  onQuickInstall,
  onToggleFavorite,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const filteredApps = selectedCategory
    ? apps.filter((a) => a.category.toLowerCase() === selectedCategory.toLowerCase())
    : [];

  const currentCategoryMeta = CATEGORY_DEFINITIONS.find((c) => c.id === selectedCategory);

  return (
    <div className="categories-view view-entrance">
      <div className="section-header">
        <h3 className="section-title">
          {selectedCategory ? `${currentCategoryMeta?.icon} ${currentCategoryMeta?.name} (${filteredApps.length})` : '🏷️ 按主题领域与分类浏览'}
        </h3>
        {selectedCategory && (
          <button
            className="btn-fluent btn-secondary"
            onClick={() => setSelectedCategory(null)}
            style={{ fontSize: '12px', padding: '4px 12px' }}
          >
            ← 返回全部分类
          </button>
        )}
      </div>

      {!selectedCategory ? (
        <div className="app-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {CATEGORY_DEFINITIONS.map((cat) => {
            const count = apps.filter((a) => a.category.toLowerCase() === cat.id.toLowerCase()).length;
            return (
              <div
                key={cat.id}
                className="app-card"
                style={{
                  alignItems: 'center',
                  textAlign: 'center',
                  padding: '22px 16px',
                  cursor: 'pointer',
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
                    fontSize: '26px',
                    marginBottom: '10px',
                    boxShadow: `0 4px 12px color-mix(in srgb, ${cat.color} 20%, transparent)`,
                  }}
                >
                  {cat.icon}
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
                  {count > 0 ? `${count} 款收录` : '浏览分类'}
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
                isFavorite={favoriteIds.has(app.id)}
                onOpenDetail={onOpenDetail}
                onQuickInstall={onQuickInstall}
                onToggleFavorite={onToggleFavorite}
              />
            ))
          ) : (
            <div style={{ color: 'var(--text-tertiary)', padding: '32px', textAlign: 'center', width: '100%' }}>
              该分类暂无收录应用，支持在顶部搜索栏输入 GitHub 仓库名在线安装。
            </div>
          )}
        </div>
      )}
    </div>
  );
};
