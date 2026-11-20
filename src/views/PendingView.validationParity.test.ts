/** 验证 TS 侧 `validatePendingDraft` 与 Rust 侧 `validate_custom_item` 的校验对齐。 */
import { describe, expect, it } from 'vitest';
import casesFixture from '../../tests/fixtures/draft-validation-cases.json';
import type { LicenseAllowlistResult } from '../services/api/catalog';
import { PENDING_EMPTY_DRAFT, validatePendingDraft, type PendingDraftItem } from './pending/draftModel';

interface CaseItem {
  id: string;
  owner: string;
  repo: string;
  name?: string;
  description?: string;
  category?: string;
  homepage?: string | null;
  license?: string;
  /** 维度样例（不参与门禁，锁定维度存在时 ok/首错序不变）。 */
  aliases?: string[];
  install_dirs?: string[];
  search_subdirs?: string[];
  publishers?: string[];
  platforms?: string[];
  identifiers?: Record<string, string[]>;
}

interface ParityCase {
  name: string;
  mode: 'draft' | 'submit';
  item: CaseItem;
  gate?: LicenseAllowlistResult;
  expect: { ok: boolean; field?: string };
}

const fixture = casesFixture as unknown as {
  gate: LicenseAllowlistResult;
  cases: ParityCase[];
};

function draftFromCase(item: CaseItem): PendingDraftItem {
  return {
    ...PENDING_EMPTY_DRAFT,
    id: item.id,
    owner: item.owner,
    repo: item.repo,
    name: item.name ?? '',
    description: item.description ?? '',
    category: item.category ?? '',
    category_name: item.category ?? '',
    homepage: item.homepage ?? '',
    license: item.license ?? '',
    aliases: item.aliases ?? PENDING_EMPTY_DRAFT.aliases,
    install_dirs: item.install_dirs ?? PENDING_EMPTY_DRAFT.install_dirs,
    search_subdirs: item.search_subdirs ?? PENDING_EMPTY_DRAFT.search_subdirs,
    publishers: item.publishers ?? PENDING_EMPTY_DRAFT.publishers,
    platforms: item.platforms ?? PENDING_EMPTY_DRAFT.platforms,
    identifiers: item.identifiers ?? PENDING_EMPTY_DRAFT.identifiers,
  };
}

/** 按与后端一致的首错优先级返回首个阻断字段。 */
function blockedField(errors: ReturnType<typeof validatePendingDraft>): string | undefined {
  if (errors.id || errors.owner || errors.repo) return 'identity';
  if (errors.name) return 'name';
  if (errors.description) return 'description';
  if (errors.category) return 'category';
  if (errors.homepage) return 'homepage';
  if (errors.license) return 'license';
  return undefined;
}

describe('草稿校验契约（TS ↔ Rust parity）', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const gate = c.gate ?? fixture.gate;
      const errors = validatePendingDraft(draftFromCase(c.item), c.mode, gate);
      expect(Object.keys(errors).length === 0).toBe(c.expect.ok);
      if (!c.expect.ok) {
        expect(blockedField(errors)).toBe(c.expect.field);
      }
    });
  }
});
