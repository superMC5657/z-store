/**
 * GitHub REST / GraphQL 极简客户端（零依赖，Node ≥ 20 全局 fetch）。
 * GraphQL 一律经 `variables` 参数化，绝不拼接查询体；令牌只放请求头，不写日志。
 */

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function headers(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'z-store-launchpad-bot',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** REST 请求；`allow404` 时 404 返回 `null`。 */
export async function rest(pathOrUrl, { method = 'GET', body, token, fetchImpl = fetch, allow404 = false } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
  const res = await fetchImpl(url, {
    method,
    headers: { ...headers(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new GitHubError(`${method} ${new URL(url).pathname} → HTTP ${res.status}`, res.status);
  if (res.status === 204) return null;
  return res.json();
}

/** GraphQL 请求：返回 `data`，`errors` 抛出。 */
export async function graphql(query, variables, { token, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${API}/graphql`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new GitHubError(`GraphQL → HTTP ${res.status}`, res.status);
  const json = await res.json();
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new GitHubError(`GraphQL: ${json.errors.map((e) => e.message).join('; ')}`, 200);
  }
  return json.data;
}

/** 以隐藏标记幂等创建或编辑机器人评论（避免刷屏）。 */
export async function upsertMarkedComment({ repo, issue, marker, body, token, fetchImpl }) {
  const comments = await rest(`/repos/${repo}/issues/${issue}/comments?per_page=100`, { token, fetchImpl });
  const mine = (comments || []).find((c) => typeof c.body === 'string' && c.body.includes(marker));
  const text = `${marker}\n${body}`;
  if (mine) {
    return rest(`/repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body: text }, token, fetchImpl });
  }
  return rest(`/repos/${repo}/issues/${issue}/comments`, { method: 'POST', body: { body: text }, token, fetchImpl });
}

export async function addLabels({ repo, issue, labels, token, fetchImpl }) {
  if (!labels.length) return;
  await rest(`/repos/${repo}/issues/${issue}/labels`, { method: 'POST', body: { labels }, token, fetchImpl });
}

export async function removeLabel({ repo, issue, label, token, fetchImpl }) {
  await rest(`/repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`, {
    method: 'DELETE',
    token,
    fetchImpl,
    allow404: true,
  });
}

/** 操作人对仓库是否具备写权限（admin / maintain / write）。 */
export async function hasWritePermission({ repo, user, token, fetchImpl }) {
  const res = await rest(`/repos/${repo}/collaborators/${encodeURIComponent(user)}/permission`, {
    token,
    fetchImpl,
    allow404: true,
  });
  const role = res?.role_name || res?.permission;
  return ['admin', 'maintain', 'write'].includes(role);
}
