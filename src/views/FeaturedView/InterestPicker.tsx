import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import { PENDING_OFFICIAL_CATEGORIES } from '../pending/draftModel';
import { categoryName } from './reasons';

interface InterestPickerProps {
  /** 保存选中的分类；返回 false 表示保存失败（保持卡片，可重试）。 */
  onSave: (categories: string[]) => Promise<boolean>;
  onSkip: () => void;
}

/** 冷启动兴趣选择卡：10 个标准分类多选，至少选 1 个才保存。 */
export const InterestPicker: React.FC<InterestPickerProps> = ({ onSave, onSkip }) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  const toggle = (cat: string) => {
    setError(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const save = async () => {
    if (selected.size === 0) {
      setError(true);
      return;
    }
    setSaving(true);
    const ok = await onSave(PENDING_OFFICIAL_CATEGORIES.filter((c) => selected.has(c)));
    setSaving(false);
    if (!ok) setError(false);
  };

  return (
    <section className="interest-picker" data-testid="interest-picker" aria-labelledby="interest-picker-title">
      <div className="interest-picker-head">
        <div>
          <h3 id="interest-picker-title" className="interest-picker-title">{t('featured.interest.title')}</h3>
          <p className="interest-picker-desc">{t('featured.interest.desc')}</p>
        </div>
        <button
          type="button"
          className="btn-fluent btn-ghost btn-sm"
          data-testid="interest-picker-skip"
          onClick={onSkip}
          aria-label={t('featured.interest.skip')}
          title={t('featured.interest.skip')}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="interest-chips" role="group" aria-label={t('featured.interest.title')}>
        {PENDING_OFFICIAL_CATEGORIES.map((cat) => {
          const on = selected.has(cat);
          return (
            <button
              key={cat}
              type="button"
              className={`interest-chip${on ? ' active' : ''}`}
              aria-pressed={on}
              data-testid={`interest-chip-${cat}`}
              onClick={() => toggle(cat)}
            >
              {on && <Check size={12} aria-hidden="true" />}
              <span>{categoryName(t, cat)}</span>
            </button>
          );
        })}
      </div>
      <div className="interest-picker-actions">
        <button
          type="button"
          className="btn-fluent btn-primary"
          data-testid="interest-picker-save"
          onClick={save}
          disabled={saving}
        >
          {t('featured.interest.save')}
        </button>
        {error && (
          <span className="interest-picker-error" role="alert" data-testid="interest-picker-error">
            {t('featured.interest.pick_one')}
          </span>
        )}
      </div>
    </section>
  );
};
