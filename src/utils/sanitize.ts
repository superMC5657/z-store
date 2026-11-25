/** 客户端 HTML 净化器：基于 DOMParser 白名单过滤 README/Changelog/Discussion，防御 XSS 与样式劫持。 */

const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'span', 'div', 'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'strike',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'img', 'a', 'br', 'hr', 'kbd',
  'details', 'summary', 'sup', 'sub',
]);

const DROP_SUBTREE_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'object', 'embed',
  'applet', 'meta', 'link', 'base', 'form',
]);

const BLOCKED_ATTRS = new Set([
  'style', 'srcdoc', 'formaction', 'action', 'xlink:href', 'background', 'poster', 'ping',
]);

const ALLOWED_HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_HREF_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

// 除 README/更新日志中内联展示所需的光栅位图外，完全阻断其他 data: URL
// （SVG 可能携带脚本/事件监听器，绝不允许放行）。
const ALLOWED_DATA_IMAGE_PREFIXES = [
  'data:image/png;',
  'data:image/png,',
  'data:image/jpeg;',
  'data:image/jpeg,',
  'data:image/jpg;',
  'data:image/jpg,',
  'data:image/gif;',
  'data:image/gif,',
  'data:image/webp;',
  'data:image/webp,',
];

// eslint-disable-next-line no-control-regex
const CONTROL_AND_SPACE_RE = /[\u0000-\u0020]+/g;
// eslint-disable-next-line no-control-regex
const EDGE_CONTROL_AND_SPACE_RE = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;
// eslint-disable-next-line no-control-regex
const HAS_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SCHEME_PREFIX_RE = /^[^/?#]*:/;
const VALID_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const SRCSET_DESCRIPTOR_RE = /^(\d+(\.\d+)?x|\d+w)$/i;

function isAllowedDataImageUrl(lowerCompact: string): boolean {
  if (!lowerCompact.startsWith('data:')) return false;
  return ALLOWED_DATA_IMAGE_PREFIXES.some((prefix) => lowerCompact.startsWith(prefix));
}

function isValidHttpUrl(url: string): boolean {
  if (HAS_CONTROL_RE.test(url)) return false;
  try {
    const parsed = new URL(url);
    return ALLOWED_HTTP_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

interface SanitizeOptions {
  /** 仓库素材直链基准地址，如 https://raw.githubusercontent.com/{owner}/{repo}/HEAD/ */
  rawBaseUrl?: string;
  /** 仓库网页链接基准地址，如 https://github.com/{owner}/{repo}/blob/HEAD/ */
  repoBaseUrl?: string;
}

function resolveRelativeAssetUrl(url: string, baseUrl: string): string | null {
  if (!baseUrl || !url) return null;
  const cleanBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const cleanPath = url.replace(/^\.?\/?/, '').replace(/^(\.\.\/)+/, '');
  try {
    const resolved = new URL(cleanPath, cleanBase);
    return ALLOWED_HTTP_PROTOCOLS.has(resolved.protocol) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

/** 严格校验 `a[href]`：仅放行 `#` 页内锚点、`http:`、`https:`、`mailto:`，或经 `repoBaseUrl` 解析后的 `http(s):`。 */
function sanitizeHref(rawVal: string, repoBaseUrl?: string): string | null {
  const trimmed = rawVal.replace(EDGE_CONTROL_AND_SPACE_RE, '');
  if (!trimmed) return null;

  // 先剥离全部 ASCII C0 控制符与空白再检测协议，防止 `java&#x09;script:` / `\u0001javascript:` 绕过。
  const compact = trimmed.replace(CONTROL_AND_SPACE_RE, '');
  if (!compact) return null;

  if (compact.startsWith('#')) {
    if (HAS_CONTROL_RE.test(trimmed)) return null;
    return trimmed;
  }

  // 阻断协议相对 URL（`//host/...` 在 WebView 中会继承非预期协议）
  if (compact.startsWith('//')) return null;

  if (SCHEME_PREFIX_RE.test(compact)) {
    const match = compact.match(VALID_SCHEME_RE);
    if (!match) return null;
    const protocol = `${match[1].toLowerCase()}:`;
    if (!ALLOWED_HREF_PROTOCOLS.has(protocol)) return null;
    if (HAS_CONTROL_RE.test(trimmed)) return null;
    if (protocol === 'mailto:') {
      return trimmed.toLowerCase().startsWith('mailto:') ? trimmed : null;
    }
    return isValidHttpUrl(trimmed) ? trimmed : null;
  }

  if (HAS_CONTROL_RE.test(trimmed)) return null;
  if (repoBaseUrl) {
    return resolveRelativeAssetUrl(trimmed, repoBaseUrl);
  }
  return null;
}

/** 严格校验 `img[src]` / `img[srcset]` 候选 URL：仅放行 `http:`、`https:`、安全光栅 `data:image/*`，或经 `rawBaseUrl` 解析后的 `http(s):`。 */
function sanitizeImgUrl(rawVal: string, rawBaseUrl?: string): string | null {
  const trimmed = rawVal.replace(EDGE_CONTROL_AND_SPACE_RE, '');
  if (!trimmed) return null;

  const compact = trimmed.replace(CONTROL_AND_SPACE_RE, '');
  if (!compact) return null;

  if (compact.startsWith('//') || compact.startsWith('#')) return null;

  if (SCHEME_PREFIX_RE.test(compact)) {
    const match = compact.match(VALID_SCHEME_RE);
    if (!match) return null;
    const protocol = `${match[1].toLowerCase()}:`;
    if (protocol === 'data:') {
      if (HAS_CONTROL_RE.test(trimmed)) return null;
      const lowerCompact = compact.toLowerCase();
      if (!trimmed.toLowerCase().startsWith('data:') || !isAllowedDataImageUrl(lowerCompact)) {
        return null;
      }
      return trimmed;
    }
    if (ALLOWED_HTTP_PROTOCOLS.has(protocol)) {
      return isValidHttpUrl(trimmed) ? trimmed : null;
    }
    return null;
  }

  if (HAS_CONTROL_RE.test(trimmed)) return null;
  if (rawBaseUrl) {
    return resolveRelativeAssetUrl(trimmed, rawBaseUrl);
  }
  return null;
}

/** 按 srcset 语法切分候选条目，正确保留 `data:image/...;base64,...` 内部的逗号。 */
function splitSrcsetCandidates(raw: string): string[] {
  const candidates: string[] = [];
  let i = 0;
  const len = raw.length;
  while (i < len) {
    while (i < len && (raw[i] === ',' || raw.charCodeAt(i) <= 0x20)) i += 1;
    if (i >= len) break;
    const start = i;
    const isData = /^data:/i.test(raw.slice(i));
    let sawDataComma = false;
    let inDescriptor = false;
    while (i < len) {
      const ch = raw[i];
      if (ch === ',') {
        if (isData && !sawDataComma && !inDescriptor) {
          sawDataComma = true;
          i += 1;
          continue;
        }
        break;
      }
      if (raw.charCodeAt(i) <= 0x20) {
        inDescriptor = true;
      }
      i += 1;
    }
    const chunk = raw.slice(start, i).trim();
    if (chunk) candidates.push(chunk);
    if (i < len && raw[i] === ',') i += 1;
  }
  return candidates;
}

function sanitizeSrcset(rawVal: string, rawBaseUrl?: string): string | null {
  const candidates = splitSrcsetCandidates(rawVal)
    .map((candidate) => {
      if (HAS_CONTROL_RE.test(candidate)) return '';
      const parts = candidate.split(/\s+/).filter(Boolean);
      if (parts.length === 0 || parts.length > 2) return '';
      if (parts.length === 2 && !SRCSET_DESCRIPTOR_RE.test(parts[1])) return '';
      const safeUrl = sanitizeImgUrl(parts[0], rawBaseUrl);
      if (!safeUrl) return '';
      return parts.length === 2 ? `${safeUrl} ${parts[1]}` : safeUrl;
    })
    .filter(Boolean);
  return candidates.length > 0 ? candidates.join(', ') : null;
}

export function sanitizeHtml(rawHtml: string, options?: SanitizeOptions): string {
  if (!rawHtml || typeof rawHtml !== 'string') {
    return '';
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');

  function cleanNode(node: Node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        const tagName = el.tagName.toLowerCase();

        // 1. 若为黑名单或不在白名单标签，移除或保留子文本
        if (!ALLOWED_TAGS.has(tagName)) {
          // 彻底销毁高危标签及其子孙内容
          if (DROP_SUBTREE_TAGS.has(tagName)) {
            el.remove();
            continue;
          }
          // 对于非高危未知标签，提升子节点，消除外层未知标签；
          // 被提升的子节点追加回待遍历队列，保证它们同样经过完整的白名单与属性核验
          while (el.firstChild) {
            const lifted = el.firstChild;
            el.parentNode?.insertBefore(lifted, el);
            children.push(lifted);
          }
          el.remove();
          continue;
        }

        // 2. 检查并清理属性
        const attrs = Array.from(el.attributes);
        for (const attr of attrs) {
          const attrName = attr.name.toLowerCase();
          const attrVal = attr.value;

          // 彻底阻断所有内联事件处理属性（如 onerror, onload, onclick 等）与危险属性（含 style）
          if (attrName.startsWith('on') || BLOCKED_ATTRS.has(attrName)) {
            el.removeAttribute(attr.name);
            continue;
          }

          if (attrName === 'href') {
            if (tagName !== 'a') {
              el.removeAttribute(attr.name);
              continue;
            }
            const safeHref = sanitizeHref(attrVal, options?.repoBaseUrl);
            if (safeHref) {
              el.setAttribute('href', safeHref);
            } else {
              el.removeAttribute(attr.name);
            }
            continue;
          }

          if (attrName === 'src') {
            if (tagName !== 'img') {
              el.removeAttribute(attr.name);
              continue;
            }
            const safeSrc = sanitizeImgUrl(attrVal, options?.rawBaseUrl);
            if (safeSrc) {
              el.setAttribute('src', safeSrc);
            } else {
              el.removeAttribute(attr.name);
            }
            continue;
          }

          if (attrName === 'srcset') {
            if (tagName !== 'img') {
              el.removeAttribute(attr.name);
              continue;
            }
            const safeSrcset = sanitizeSrcset(attrVal, options?.rawBaseUrl);
            if (safeSrcset) {
              el.setAttribute('srcset', safeSrcset);
            } else {
              el.removeAttribute(attr.name);
            }
            continue;
          }
        }

        // 3. 仅对外部 <a> 链接附加安全属性与在新窗口打开；页内 #anchor 链接保持原位导航
        if (tagName === 'a') {
          const safeHref = (el.getAttribute('href') ?? '').trim();
          if (safeHref && !safeHref.startsWith('#')) {
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
          } else {
            el.removeAttribute('target');
            el.removeAttribute('rel');
          }
        }

        // 4. 对 <img> 标签自动附加防盗链策略与平滑异步懒加载
        if (tagName === 'img') {
          el.setAttribute('referrerpolicy', 'no-referrer');
          if (!el.getAttribute('loading')) {
            el.setAttribute('loading', 'lazy');
          }
          if (!el.getAttribute('decoding')) {
            el.setAttribute('decoding', 'async');
          }
        }

        // 递归处理子节点
        cleanNode(el);
      }
    }
  }

  cleanNode(doc.body);
  return doc.body.innerHTML;
}
