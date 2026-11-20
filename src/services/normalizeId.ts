/**
 * Canonical App Id 前端归一入口（与后端 `forge/coord.rs` 解析分支对齐）。
 * 可解析坐标转为 canonical id，不可解析回退 `trim().toLowerCase()`。
 */

export type CanonicalForge = 'github' | 'codeberg' | 'gitea' | 'gitlab';

export interface ParsedCanonicalCoord {
  id: string;
  forge: CanonicalForge;
  forge_host: string;
  owner: string;
  repo: string;
}

/** forge 前缀短语法别名表（后端 `RepositoryUrlParser` 分支 2 同表）。 */
const FORGE_PREFIX_ALIASES: Record<string, CanonicalForge> = {
  github: 'github',
  gh: 'github',
  codeberg: 'codeberg',
  cb: 'codeberg',
  gitea: 'gitea',
  gt: 'gitea',
  gitlab: 'gitlab',
  gl: 'gitlab',
};

const FORGE_DEFAULT_HOSTS: Record<CanonicalForge, string> = {
  github: 'github.com',
  codeberg: 'codeberg.org',
  gitea: 'gitea.com',
  gitlab: 'gitlab.com',
};

/** 宿主归一（后端 `matches_host` 同口径）：剥 `:port` 与尾点、小写化。 */
function normalizeForgeHost(host: string): string {
  const colon = host.indexOf(':');
  const withoutPort = colon >= 0 ? host.slice(0, colon) : host;
  return withoutPort.trim().replace(/\.+$/, '').toLowerCase();
}

/** 宿主精确或白名单子域匹配（后端 `ForgeType::matches_host` 同口径）。 */
function matchesForgeHost(forge: CanonicalForge, host: string): boolean {
  const domain = FORGE_DEFAULT_HOSTS[forge];
  const normalized = normalizeForgeHost(host);
  return normalized === domain || normalized.endsWith(`.${domain}`);
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
function toAppId(forge: CanonicalForge, host: string, owner: string, repo: string): string {
  if (forge === 'github' && host === 'github.com') return `${owner}/${repo}`;
  if (host === FORGE_DEFAULT_HOSTS[forge]) return `${forge}:${owner}/${repo}`;
  return `${forge}:${host}/${owner}/${repo}`;
}

function buildParsedCoord(
  forge: CanonicalForge,
  host: string,
  owner: string,
  repo: string,
): ParsedCanonicalCoord {
  const cleanHost = host.toLowerCase();
  const cleanOwner = owner.toLowerCase();
  const cleanRepo = repo.toLowerCase();
  return {
    id: toAppId(forge, cleanHost, cleanOwner, cleanRepo),
    forge,
    forge_host: cleanHost,
    owner: cleanOwner,
    repo: cleanRepo,
  };
}

/** 三条解析分支（后端 `RepositoryUrlParser::parse` 一一对应），解析为结构化坐标。 */
export function parseCanonicalCoord(input: unknown): ParsedCanonicalCoord | null {
  if (typeof input !== 'string') return null;
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
      const forge: CanonicalForge = matchesForgeHost('github', host)
        ? 'github'
        : matchesForgeHost('codeberg', host)
          ? 'codeberg'
          : matchesForgeHost('gitlab', host)
            ? 'gitlab'
            : 'gitea';
      // 默认宿主的端口/尾点写法折叠为裸域名，使同仓不同写法落到同一 canonical id；
      // 自建宿主保留原样（含端口），与后端 canonical 同键。
      const canonicalHost =
        normalizeForgeHost(host) === FORGE_DEFAULT_HOSTS[forge] ? FORGE_DEFAULT_HOSTS[forge] : host;
      if (
        validCoordSegment(canonicalHost) &&
        validCoordSegment(owner) &&
        validCoordSegment(repo)
      ) {
        return buildParsedCoord(forge, canonicalHost, owner, repo);
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
          return buildParsedCoord(forge, host, owner, repo);
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
      if (validCoordSegment(owner) && validCoordSegment(repo)) {
        return buildParsedCoord('github', 'github.com', owner, repo);
      }
    }
  }

  return null;
}

/** 三条解析分支（后端 `RepositoryUrlParser::parse` 一一对应），不可解析返回 null。 */
function parseCanonical(input: string): string | null {
  return parseCanonicalCoord(input)?.id ?? null;
}

/** 解析 canonical id；不可解析时返回 `null`（供校验场景区分非法输入）。 */
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

/** 归一并去重的 id 集合。 */
export function normalizeIdLowerSet(ids: Iterable<unknown>): Set<string> {
  const out = new Set<string>();
  for (const raw of ids) {
    const k = normalizeId(raw);
    if (k) out.add(k);
  }
  return out;
}
