/**
 * 轻量级且严格的客户端 HTML 净化器
 * 利用浏览器内置 DOMParser 进行 AST 级白名单过滤，彻底防御外部 README/Changelog 潜在的 XSS 攻击
 */

const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'span', 'div', 'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'strike',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'img', 'a', 'br', 'hr', 'kbd',
  'details', 'summary', 'sup', 'sub',
  'video', 'audio', 'source',
]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'asset:', 'tauri:']);

export function sanitizeHtml(rawHtml: string): string {
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
          if (['script', 'style', 'iframe', 'frame', 'object', 'embed', 'applet', 'meta', 'link', 'base', 'form'].includes(tagName)) {
            el.remove();
            continue;
          }
          // 对于非高危未知标签，提升子节点，消除外层危险标签
          while (el.firstChild) {
            el.parentNode?.insertBefore(el.firstChild, el);
          }
          el.remove();
          continue;
        }

        // 2. 检查并清理属性
        const attrs = Array.from(el.attributes);
        for (const attr of attrs) {
          const attrName = attr.name.toLowerCase();
          const attrVal = attr.value.trim();

          // 彻底阻断所有内联事件处理属性（如 onerror, onload, onclick 等）
          if (attrName.startsWith('on')) {
            el.removeAttribute(attr.name);
            continue;
          }

          // 严格核验链接类属性（href, src）协议
          if (attrName === 'href' || attrName === 'src') {
            const lowerVal = attrVal.toLowerCase();
            // 阻断 javascript:, vbscript:, data:text/html 等恶意伪协议
            if (lowerVal.startsWith('javascript:') || lowerVal.startsWith('vbscript:') || lowerVal.startsWith('data:text/')) {
              el.removeAttribute(attr.name);
              continue;
            }

            // 针对绝对 URL 校验白名单协议
            if (attrVal.includes('://')) {
              try {
                const parsedUrl = new URL(attrVal);
                if (!ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
                  el.removeAttribute(attr.name);
                  continue;
                }
              } catch {
                el.removeAttribute(attr.name);
                continue;
              }
            }
          }

          // 净化 style 属性中可能的 expression() 或 url(javascript:)
          if (attrName === 'style') {
            const lowerStyle = attrVal.toLowerCase();
            if (lowerStyle.includes('expression') || lowerStyle.includes('javascript:') || lowerStyle.includes('behavior')) {
              el.removeAttribute(attr.name);
              continue;
            }
          }
        }

        // 3. 对 <a> 标签强制附加安全属性与在新窗口打开
        if (tagName === 'a') {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }

        // 递归处理子节点
        cleanNode(el);
      }
    }
  }

  cleanNode(doc.body);
  return doc.body.innerHTML;
}
