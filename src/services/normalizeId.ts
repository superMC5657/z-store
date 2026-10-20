/**
 * Canonical App Id 前端唯一归一口（ADR-0010）。
 *
 * - 后端全形态 canonical（`owner/repo` / `forge[:host]:owner/repo` 解析）唯一源在
 *   `src-tauri/src/forge/coord.rs`（`RepositoryUrlParser` / `canonical_app_id` /
 *   `canonical_lookup_id`）；前端经本模块解析镜像对齐（#35：纯 trim+lowercase
 *   不解析前缀，与后端 canonical 深度分叉致 enrich/比对键 merge miss，已收口）。
 *   语义同后端 `canonical_lookup_id`（total）：可解析直取 canonical，不可解析
 *   回退 `trim().toLowerCase()`（不断路由；门禁类拒绝语义另见 `canonicalAppId`）。
 *   前端同步键路径无法逐键 await Rust，镜像与后端解析分支一一对应，对齐锁值在
 *   `normalizeId.test.ts`（与 coord.rs 单测同案例）。
 * - 前端散装 `trim().toLowerCase()` / `(x || '').toLowerCase()` 一律经此，不另立
 *   normalizer（`platformFilter` loading 键语义归 `lib/platformFilter`，键归一与其同值）。
 */

/** forge 前缀短语法别名表（后端 `RepositoryUrlParser` 分支 2 同表）。 */
const FORGE_PREFIX_ALIASES: Record<string, string> = {
  github: 'github',
  gh: 'github',
  codeberg: 'codeberg',
  cb: 'codeberg',
  gitea: 'gitea',
  gt: 'gitea',
  gitlab: 'gitlab',
  gl: 'gitlab',
};

const FORGE_DEFAULT_HOSTS: Record<string, string> = {
  github: 'github.com',
  codeberg: 'codeberg.org',
  gitea: 'gitea.com',
  gitlab: 'gitlab.com',
};

/** 宿主精确或白名单子域匹配（后端 `ForgeType::matches_host` 同口径）。 */
function matchesForgeHost(forge: string, host: string): boolean {
  const domain = FORGE_DEFAULT_HOSTS[forge];
  return host === domain || host.endsWith(`.${domain}`);
}

/** 坐标段校验（后端 `valid_coord_segment` 镜像）：拒绝空段与 `?`/`#`/`/`/`\`/空白。 */
function validCoordSegment(s: string): boolean {
  return (
    s.length > 0 &&
    !s.includes('?') &&
    !s.includes('#') &&
    !s.includes('/') &&
    !s.includes('\\') &&
    !/\s/.test(s)
  );
}

/** repo 段清洗（后端各解析分支同序）：先截 `?`/`#`，再剥 `.git` 后缀。 */
function cleanRepoPart(repoPart: string): string {
  let repo = repoPart;
  const q = repo.indexOf('?');
  if (q >= 0) repo = repo.slice(0, q);
  const h = repo.indexOf('#');
  if (h >= 0) repo = repo.slice(0, h);
  return repo.endsWith('.git') ? repo.slice(0, -4) : repo;
}

/** canonical id 构造（后端 `UniversalRepoCoord::to_app_id` 镜像，调用方统一小写）。 */
function toAppId(forge: string, host: string, owner: string, repo: string): string {
  if (forge === 'github' && host === 'github.com') return `${owner}/${repo}`;
  if (host === FORGE_DEFAULT_HOSTS[forge]) return `${forge}:${owner}/${repo}`;
  return `${forge}:${host}/${owner}/${repo}`;
}

/** 三条解析分支（后端 `RepositoryUrlParser::parse` 一一对应），不可解析返回 null。 */
function parseCanonical(input: string): string | null {
  const s = input.trim();
  if (!s) return null;

  // 1. 完整 Web URL（host 判 forge：github/codeberg/gitlab 白名单，自建默认 gitea）
  if (s.startsWith('http://') || s.startsWith('https://')) {
    const withoutProto = s.startsWith('https://') ? s.slice('https://'.length) : s.slice('http://'.length);
    const parts = withoutProto.split('/').filter((p) => p.length > 0);
    if (parts.length >= 3) {
      const host = parts[0].trim().toLowerCase();
      const owner = parts[1].trim();
      const repo = cleanRepoPart(parts[2].trim());
      const forge = matchesForgeHost('github', host)
        ? 'github'
        : matchesForgeHost('codeberg', host)
          ? 'codeberg'
          : matchesForgeHost('gitlab', host)
            ? 'gitlab'
            : 'gitea';
      if (validCoordSegment(host) && validCoordSegment(owner) && validCoordSegment(repo)) {
        return toAppId(forge, host, owner, repo).toLowerCase();
      }
      return null;
    }
  }

  // 2. 前缀短语法（2 段 = 默认 host，3 段 = 自建 host；未知前缀落空走后续分支）
  const colon = s.indexOf(':');
  if (colon > 0) {
    const forge = FORGE_PREFIX_ALIASES[s.slice(0, colon).toLowerCase()];
    if (forge) {
      const parts = s.slice(colon + 1).split('/').filter((p) => p.length > 0);
      if (parts.length === 2 || parts.length === 3) {
        const host = (parts.length === 3 ? parts[0] : FORGE_DEFAULT_HOSTS[forge]).trim();
        const owner = (parts.length === 3 ? parts[1] : parts[0]).trim();
        const repo = cleanRepoPart(parts[parts.length - 1].trim());
        if (validCoordSegment(host) && validCoordSegment(owner) && validCoordSegment(repo)) {
          return toAppId(forge, host, owner, repo).toLowerCase();
        }
        return null;
      }
    }
  }

  // 3. 裸 owner/repo（默认 GitHub；含空白或 `:` 不入此分支）
  if (s.includes('/') && !s.includes(' ') && !s.includes(':')) {
    const parts = s.split('/').filter((p) => p.length > 0);
    if (parts.length === 2) {
      const owner = parts[0].trim();
      const repo = cleanRepoPart(parts[1].trim());
      if (owner.length > 0 && repo.length > 0) {
        return toAppId('github', 'github.com', owner, repo).toLowerCase();
      }
    }
  }

  return null;
}

/**
 * canonical 解析 Option 形态（后端 `canonical_app_id` 镜像）：可解析返回 canonical
 * id，不可解析返回 `null`。供门禁类调用方区分「不可解析需拒绝」与 `normalizeId`
 * 的「原样小写兜底」（草稿 forge 门见 `api/catalog.ts#draftForgeGateError`）。
 */
export function canonicalAppId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  return parseCanonical(id.trim());
}

/** id 归一（后端 `canonical_lookup_id` 同语义）：可解析直取 canonical，不可解析回退 `trim().toLowerCase()`，非字符串按空处理。 */
export function normalizeId(id: unknown): string {
  if (typeof id !== 'string') return '';
  const trimmed = id.trim();
  if (!trimmed) return '';
  return parseCanonical(trimmed) ?? trimmed.toLowerCase();
}

/** 归一去重保序：去空 + 按小写去重。 */
export function normalizeIdSet(ids: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const k = normalizeId(raw);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * 归一 id 集（Set 口径，`normalizeIdSet` 的 Set 形态）。
 * 去空 + 小写去重；调用方一律经此建索引。
 */
export function normalizeIdLowerSet(ids: Iterable<unknown>): Set<string> {
  const out = new Set<string>();
  for (const raw of ids) {
    const k = normalizeId(raw);
    if (k) out.add(k);
  }
  return out;
}
