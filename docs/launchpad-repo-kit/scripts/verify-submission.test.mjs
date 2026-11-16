import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORM_HEADINGS,
  checkSubmissionFields,
  evaluateRepo,
  parseSubmission,
  renderReport,
  verifySubmission,
} from './verify-submission.mjs';
import { deriveId, parseRepoUrl, platformsFromAssets } from './lib/shared.mjs';

function issueBody(values) {
  return Object.entries(FORM_HEADINGS)
    .map(([id, heading]) => `### ${heading}\n\n${values[id] ?? '_No response_'}\n`)
    .join('\n');
}

const VALID = {
  repo_url: 'https://github.com/acme/hyper-term',
  app_name: 'HyperTerm',
  category: 'dev — 开发编程 / Developer tools',
  maker_note: '重写了 WebGPU 渲染管线，\n万行滚动依旧丝滑。',
  launch_tier: 'spotlight-7d — 申请顶部「置顶推荐」7 天赞助位 / Spotlight for 7 days',
  floss_confirm: '- [X] 项目采用 OSI 认证开源协议',
};

test('解析 Issue Form：多行自荐语折叠为单行，空选填项为空串', () => {
  const sub = parseSubmission(issueBody(VALID));
  assert.equal(sub.repo_url, 'https://github.com/acme/hyper-term');
  assert.equal(sub.category, 'dev');
  assert.equal(sub.launch_tier, 'spotlight-7d');
  assert.equal(sub.maker_note, '重写了 WebGPU 渲染管线， 万行滚动依旧丝滑。');
  assert.equal(sub.maker_note_en, '');
  assert.equal(sub.custom_icon_url, '');
  assert.equal(sub.floss_confirmed, true);
  assert.deepEqual(checkSubmissionFields(sub), []);
});

test('恶意 Markdown 不越界：伪造标题不能覆盖其他字段，脚本只当数据', () => {
  const body = issueBody({
    ...VALID,
    app_name: 'Evil<script>alert(1)</script>',
    maker_note: 'note\n\n## 上架档位 / Launch tier\nfree',
  });
  const sub = parseSubmission(body);
  assert.equal(sub.launch_tier, 'spotlight-7d');
  assert.ok(sub.maker_note.includes('## 上架档位'));
  const report = renderReport({ ok: false, errors: ['x'], item: { ...fakeItem(), name: sub.app_name }, submission: sub });
  const outsideFences = report.replace(/```[\s\S]*?```/g, '');
  assert.ok(!outsideFences.includes('<script>'), '表格单元格中的 HTML 必须转义');
  assert.ok(outsideFences.includes('&lt;script&gt;'));
});

test('字段校验：超长自荐、非 https 图标、未勾选承诺、坏讨论链接', () => {
  const sub = parseSubmission(
    issueBody({
      ...VALID,
      maker_note: '字'.repeat(141),
      custom_icon_url: 'http://x/icon.png',
      linked_discussion_url: 'https://github.com/a/b/issues/1',
      floss_confirm: '- [ ] 未勾选',
    }),
  );
  const errors = checkSubmissionFields(sub);
  assert.ok(errors.some((e) => e.includes('1~140')));
  assert.ok(errors.some((e) => e.includes('https://')));
  assert.ok(errors.some((e) => e.includes('关联 Discussion')));
  assert.ok(errors.some((e) => e.includes('开源承诺')));
});

test('仓库地址解析与规范标识推导', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/Acme/Hyper-Term.git'), {
    forge: 'github', forge_host: 'github.com', owner: 'Acme', repo: 'Hyper-Term',
  });
  assert.equal(deriveId(parseRepoUrl('https://github.com/Acme/Hyper-Term')), 'acme/hyper-term');
  assert.equal(deriveId(parseRepoUrl('https://codeberg.org/pix/palette')), 'codeberg:pix/palette');
  assert.equal(deriveId(parseRepoUrl('https://gitlab.example.org/team/tool')), 'gitlab:gitlab.example.org/team/tool');
  assert.equal(parseRepoUrl('http://github.com/a/b'), null);
  assert.equal(parseRepoUrl('https://evil.com/a/b'), null);
  assert.equal(parseRepoUrl('https://github.com/../b'), null);
});

test('资产后缀推导平台', () => {
  assert.deepEqual(
    platformsFromAssets(['app-setup.exe', 'app.dmg', 'app.AppImage', 'app.apk', 'checksums.txt']),
    ['windows', 'macos', 'linux', 'android'],
  );
  assert.deepEqual(platformsFromAssets(['source.tar.gz']), []);
});

function fakeFacts(overrides = {}) {
  return {
    private: false, archived: false, fork: false, license: 'MIT', stars: 420, forks: 10,
    description: 'GPU terminal', homepage: '', owner_avatar: 'https://avatars.githubusercontent.com/u/1',
    owner_html: 'https://github.com/acme', latest_version: 'v0.4.2', latest_release_at: '2027-01-09T00:00:00Z',
    assets: ['hyper-setup.exe', 'hyper.AppImage'], ...overrides,
  };
}

function fakeItem() {
  return { id: 'acme/hyper-term', name: 'HyperTerm', license: 'MIT', latest_version: 'v1', platforms: ['windows'], maker_note: 'x' };
}

test('仓库体检：私有、归档、Fork、NOASSERTION、无安装包均标红', () => {
  assert.deepEqual(evaluateRepo(fakeFacts()).errors, []);
  assert.deepEqual(evaluateRepo(fakeFacts()).platforms, ['windows', 'linux']);
  const bad = evaluateRepo(fakeFacts({ private: true, archived: true, fork: true, license: 'NOASSERTION', assets: ['src.zip'] }));
  assert.equal(bad.errors.length, 5);
  assert.ok(evaluateRepo(fakeFacts({ license: 'BUSL-1.1' })).errors[0].includes('BUSL-1.1'));
  assert.ok(evaluateRepo(null).errors[0].includes('不存在'));
});

function fakeFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : null;
    return {
      ok: body !== null,
      status: body === null ? 404 : 200,
      json: async () => body,
    };
  };
}

test('端到端体检：GitHub 仓库通过并生成预览条目', async () => {
  const fetchImpl = fakeFetch({
    '/releases/latest': { tag_name: 'v0.4.2', published_at: '2027-01-09T00:00:00Z', assets: [{ name: 'hyper.msi' }, { name: 'hyper.deb' }] },
    '/repos/acme/hyper-term': {
      private: false, archived: false, fork: false, license: { spdx_id: 'MIT' }, stargazers_count: 420, forks_count: 10,
      description: 'GPU terminal', homepage: '', owner: { avatar_url: 'https://avatars.githubusercontent.com/u/1', html_url: 'https://github.com/acme' },
    },
  });
  const result = await verifySubmission(issueBody(VALID), { fetchImpl, nowIso: '2027-01-15T00:00:00.000Z' });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.item.id, 'acme/hyper-term');
  assert.deepEqual(result.item.platforms, ['windows', 'linux']);
  assert.equal(result.item.launched_at, '2027-01-15T00:00:00Z');
  assert.equal(result.item.category_name, '开发编程');
  assert.ok(renderReport(result).includes('自动体检通过'));
});

test('端到端体检：仓库不存在时报错', async () => {
  const result = await verifySubmission(issueBody(VALID), { fetchImpl: fakeFetch({}) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('不存在')));
});
