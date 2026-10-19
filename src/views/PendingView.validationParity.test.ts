/**
 * 草稿校验契约（parity）：同一组样例分别跑 TS 的 `validatePendingDraft`（UI 即时镜像）
 * 与 Rust 的 `validate_custom_item`（权威门禁），断言 ok 与首个阻断字段一致。
 *
 * 样例唯一来源：`tests/fixtures/draft-validation-cases.json`（Rust 侧同文件 include_str!）。
 * 新增校验规则先加样例，两侧同时红再实现，避免两套口径漂移。
 */
import { describe, expect, it } from 'vitest';
import casesFixture from '../../tests/fixtures/draft-validation-cases.json';
import type { LicenseAllowlistResult } from '../services/api/catalog';
import { PENDING_EMPTY_DRAFT, validatePendingDraft, type PendingDraftItem } from './PendingView';

interface CaseItem {
  id: string;
  owner: string;
  repo: string;
  name?: string;
  description?: string;
  category?: string;
  homepage?: string | null;
  license?: string;
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
  };
}

/**
 * 首个阻断字段（与 Rust `validate_custom_item` 的首错顺序对齐）：
 * identity → name → description → category → homepage → license。
 */
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
