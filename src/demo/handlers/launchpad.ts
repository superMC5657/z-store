import type {
  AppSummary,
  LaunchpadDiscussionComment,
  LaunchpadDiscussionDetail,
  LaunchpadEntry,
  LaunchpadFeedResponse,
  LaunchpadUpvoteResult,
} from '../../types';
import { getStarSet } from '../demoState';
import { argNum, argStr, DAY_SECS, nowSecs, warnUnknownArgs, type InvokeArgs } from './common';

const DISCUSSIONS_REPO = 'superMC5657/z-store-launchpad';

interface DemoSeed {
  id: string;
  name: string;
  forge?: 'github' | 'codeberg';
  description: string;
  description_en: string;
  category: string;
  category_name: string;
  license: string;
  version: string;
  platforms: string[];
  stars: number;
  delta: number;
  note: string;
  note_en: string;
  daysAgo: number;
  number: number;
  comments: number;
  upvotes: number;
}

// 演示数据全部为虚构项目，仅用于在线 Demo 展示广场交互。
const SPOTLIGHT: DemoSeed[] = [
  {
    id: 'acme/hyper-term', name: 'HyperTerm', description: 'GPU 加速的跨平台终端', description_en: 'GPU-accelerated cross-platform terminal',
    category: 'dev', category_name: '开发工具', license: 'MIT', version: 'v0.4.2', platforms: ['windows', 'macos', 'linux'],
    stars: 420, delta: 135, note: '重写了 WebGPU 渲染管线，万行滚动依旧丝滑。', note_en: 'Rewrote the WebGPU renderer — 10k-line scrollback stays silky.',
    daysAgo: 3, number: 101, comments: 18, upvotes: 64,
  },
  {
    id: 'linus-dev/noteflow', name: 'NoteFlow', description: '纯本地双向链接笔记', description_en: 'Local-first bidirectional note taking',
    category: 'office', category_name: '办公效率', license: 'GPL-3.0', version: 'v1.1.0', platforms: ['windows', 'linux'],
    stars: 180, delta: 42, note: '纯本地双向链接笔记，数据永远只在你的磁盘上。', note_en: 'Local-first linked notes — your data never leaves your disk.',
    daysAgo: 2, number: 102, comments: 9, upvotes: 29,
  },
  {
    id: 'codeberg:pixel-forge/palette', name: 'Palette', forge: 'codeberg', description: '为像素画师打造的调色板管理器', description_en: 'Palette manager for pixel artists',
    category: 'graphics', category_name: '图形设计', license: 'MPL-2.0', version: 'v2.0.0', platforms: ['windows', 'macos', 'linux'],
    stars: 96, delta: 21, note: '一键从任意图片提取调色板并导出到 Aseprite。', note_en: 'Extract palettes from any image and export straight to Aseprite.',
    daysAgo: 5, number: 103, comments: 4, upvotes: 17,
  },
];

const RECENT: DemoSeed[] = [
  {
    id: 'quietbyte/clipnest', name: 'ClipNest', description: '剪贴板历史与片段管理', description_en: 'Clipboard history and snippets',
    category: 'system', category_name: '系统工具', license: 'Apache-2.0', version: 'v0.9.1', platforms: ['windows', 'macos'],
    stars: 75, delta: 30, note: '支持正则搜索的剪贴板历史，零联网。', note_en: 'Clipboard history with regex search, fully offline.',
    daysAgo: 1, number: 104, comments: 3, upvotes: 12,
  },
  {
    id: 'meshlab-oss/tunnelkit', name: 'TunnelKit', description: '可视化 WireGuard 隧道管理', description_en: 'Visual WireGuard tunnel manager',
    category: 'network', category_name: '网络工具', license: 'GPL-2.0', version: 'v1.3.0', platforms: ['windows', 'linux', 'android'],
    stars: 310, delta: 12, note: '把 WireGuard 配置变成拖拽式图形界面。', note_en: 'Turns WireGuard configs into a drag-and-drop UI.',
    daysAgo: 6, number: 105, comments: 22, upvotes: 40,
  },
  {
    id: 'codeberg:readwell/folio', name: 'Folio', forge: 'codeberg', description: '极简 EPUB 阅读器', description_en: 'Minimal EPUB reader',
    category: 'reading', category_name: '阅读学习', license: 'AGPL-3.0', version: 'v0.5.0', platforms: ['linux', 'android'],
    stars: 54, delta: 8, note: '无广告、无追踪的 EPUB 阅读器，支持跨设备进度同步。', note_en: 'Ad-free, tracker-free EPUB reader with progress sync.',
    daysAgo: 4, number: 106, comments: 6, upvotes: 9,
  },
  {
    id: 'sora-labs/beatgrid', name: 'BeatGrid', description: '本地音乐库 BPM 分析与整理', description_en: 'BPM analysis for local music libraries',
    category: 'media', category_name: '影音娱乐', license: 'MIT', version: 'v0.2.3', platforms: ['windows', 'macos', 'linux'],
    stars: 128, delta: 64, note: '为 DJ 准备的本地曲库 BPM 与调性批量分析。', note_en: 'Batch BPM and key analysis for DJs’ local libraries.',
    daysAgo: 8, number: 107, comments: 11, upvotes: 25,
  },
  {
    id: 'vaultwise/keyring-lite', name: 'Keyring Lite', description: '离线 TOTP 两步验证器', description_en: 'Offline TOTP authenticator',
    category: 'security', category_name: '安全隐私', license: 'BSD-3-Clause', version: 'v1.0.0', platforms: ['windows', 'macos', 'linux', 'ios'],
    stars: 260, delta: 4, note: '离线 TOTP 验证器，加密备份到你自己的存储。', note_en: 'Offline TOTP with encrypted backups to your own storage.',
    daysAgo: 12, number: 108, comments: 2, upvotes: 6,
  },
  {
    id: 'tinyrogue/dungeon-dash', name: 'Dungeon Dash', description: '像素风 Roguelike 小游戏', description_en: 'Pixel-art roguelike',
    category: 'games', category_name: '游戏娱乐', license: 'GPL-3.0', version: 'v0.1.0', platforms: ['windows', 'linux'],
    stars: 33, delta: 15, note: '一局五分钟的像素地牢冒险，关卡全部程序生成。', note_en: 'Five-minute pixel dungeon runs with procedural levels.',
    daysAgo: 0, number: 109, comments: 5, upvotes: 14,
  },
];

function isoDaysAgo(days: number): string {
  return new Date((nowSecs() - days * DAY_SECS) * 1000).toISOString();
}

function toEntry(seed: DemoSeed, pinned: boolean, order: number): LaunchpadEntry {
  const forge = seed.forge ?? 'github';
  const coord = seed.id.includes(':') ? seed.id.split(':')[1] : seed.id;
  const [owner, repo] = coord.split('/');
  const host = forge === 'codeberg' ? 'codeberg.org' : 'github.com';
  const summary: AppSummary = {
    id: seed.id,
    name: seed.name,
    description: seed.description,
    description_en: seed.description_en,
    owner,
    repo,
    icon: '',
    icon_bg: '',
    stars: seed.stars,
    forks: Math.round(seed.stars / 8),
    license: seed.license,
    latest_version: seed.version,
    category: seed.category,
    category_name: seed.category_name,
    is_verified: false,
    is_cataloged: false,
    forge,
    forge_host: host,
    homepage: null,
    platforms: seed.platforms,
  };
  return {
    summary,
    maker_note: seed.note,
    maker_note_en: seed.note_en,
    maker: { login: owner, name: null, avatar_url: '', html_url: `https://${host}/${owner}` },
    launched_at: isoDaysAgo(seed.daysAgo),
    latest_release_at: isoDaysAgo(seed.daysAgo),
    stars_7d_delta: seed.delta,
    discussion_repo: DISCUSSIONS_REPO,
    discussion_number: seed.number,
    discussion_node_id: `D_demo_${seed.number}`,
    discussion_url: `https://github.com/${DISCUSSIONS_REPO}/discussions/${seed.number}`,
    discussion_comments_count: seed.comments,
    discussion_upvotes: seed.upvotes,
    is_pinned: pinned,
    pin_until: pinned ? isoDaysAgo(-7 - order) : null,
    pin_tier: pinned ? 'sponsor' : null,
    viewer_has_starred: false,
  };
}

// 内存态：顶帖与评论交互在会话内可见。
const upvoteState = new Map<number, { count: number; mine: boolean }>();
const commentState = new Map<number, LaunchpadDiscussionComment[]>();
let commentSeq = 0;

function allSeeds(): DemoSeed[] {
  return [...SPOTLIGHT, ...RECENT];
}

function seedByNumber(n: number): DemoSeed | undefined {
  return allSeeds().find((s) => s.number === n);
}

function upvotes(seed: DemoSeed): { count: number; mine: boolean } {
  return upvoteState.get(seed.number) ?? { count: seed.upvotes, mine: false };
}

function demoComments(seed: DemoSeed): LaunchpadDiscussionComment[] {
  const existing = commentState.get(seed.number);
  if (existing) return existing;
  const coord = seed.id.includes(':') ? seed.id.split(':')[1] : seed.id;
  const owner = coord.split('/')[0];
  const author = (login: string) => ({ login, avatar_url: '', html_url: `https://github.com/${login}` });
  const initial: LaunchpadDiscussionComment[] = [
    {
      id: `DC_${seed.number}_1`,
      body: '试用了一下，**体验很棒**！期待后续更新。',
      created_at: isoDaysAgo(1),
      author_association: 'NONE',
      author: author('early-adopter'),
      upvote_count: 3,
      viewer_has_upvoted: false,
      replies: [
        {
          id: `DC_${seed.number}_2`,
          body: '感谢反馈，下个版本会继续打磨～',
          created_at: isoDaysAgo(0),
          author_association: 'OWNER',
          author: author(owner),
          upvote_count: 1,
          viewer_has_upvoted: false,
          replies: [],
        },
      ],
    },
  ];
  commentState.set(seed.number, initial);
  return initial;
}

function withLiveState(entry: LaunchpadEntry): LaunchpadEntry {
  const seed = seedByNumber(entry.discussion_number);
  if (!seed) return entry;
  const starred = getStarSet().has(entry.summary.id.toLowerCase());
  const extraComments = (commentState.get(seed.number)?.length ?? 1) - 1;
  return {
    ...entry,
    discussion_upvotes: upvotes(seed).count,
    discussion_comments_count: seed.comments + Math.max(0, extraComments),
    viewer_has_starred: starred,
  };
}

export function handleGetLaunchpadFeed(a: InvokeArgs): LaunchpadFeedResponse {
  warnUnknownArgs(['forceRefresh'], a, 'get_launchpad_feed');
  return {
    spotlight: SPOTLIGHT.map((s, i) => withLiveState(toEntry(s, true, i))),
    items: RECENT.map((s, i) => withLiveState(toEntry(s, false, i))),
    discussions_repo: DISCUSSIONS_REPO,
    submit_issue_url: `https://github.com/${DISCUSSIONS_REPO}/issues/new?template=submit-launchpad.yml`,
    submit_web_url: 'https://z-store.org/launchpad/submit',
    generated_at: isoDaysAgo(0),
    cached_at: nowSecs(),
    is_stale: false,
  };
}

export function handleGetLaunchpadDiscussion(a: InvokeArgs): LaunchpadDiscussionDetail {
  warnUnknownArgs(['discussionRepo', 'discussionNumber', 'cursor', 'forceRefresh'], a, 'get_launchpad_discussion');
  const number = argNum(a, 'discussionNumber') ?? 0;
  const seed = seedByNumber(number);
  const url = `https://github.com/${argStr(a, 'discussionRepo') || DISCUSSIONS_REPO}/discussions/${number}`;
  if (!seed) {
    throw new Error('讨论不存在');
  }
  const comments = demoComments(seed);
  const votes = upvotes(seed);
  return {
    id: `D_demo_${seed.number}`,
    number,
    title: `${seed.name} — ${seed.note}`,
    body: `${seed.description}\n\n${seed.note}`,
    url,
    created_at: isoDaysAgo(seed.daysAgo),
    locked: false,
    closed: false,
    author: { login: 'zstore-bot', avatar_url: '', html_url: 'https://github.com/zstore-bot' },
    category_name: 'Launches',
    upvote_count: votes.count,
    viewer_has_upvoted: votes.mine,
    viewer_can_upvote: true,
    viewer_can_comment: true,
    auth_required_for_write: false,
    comments_total: comments.length,
    has_next_page: false,
    end_cursor: null,
    comments,
    is_stale: false,
  };
}

export function handleAddLaunchpadComment(a: InvokeArgs): LaunchpadDiscussionComment {
  warnUnknownArgs(['discussionRepo', 'discussionNumber', 'discussionId', 'body', 'replyToId'], a, 'add_launchpad_comment');
  const number = argNum(a, 'discussionNumber') ?? 0;
  const seed = seedByNumber(number);
  const body = argStr(a, 'body').trim();
  if (!seed) throw new Error('讨论不存在');
  if (!body) throw new Error('评论内容不能为空');
  const comment: LaunchpadDiscussionComment = {
    id: `DC_demo_new_${++commentSeq}`,
    body,
    created_at: new Date().toISOString(),
    author_association: 'NONE',
    author: { login: 'demo-user', avatar_url: '', html_url: 'https://github.com/demo-user' },
    upvote_count: 0,
    viewer_has_upvoted: false,
    replies: [],
  };
  const list = demoComments(seed);
  const replyTo = argStr(a, 'replyToId');
  const parent = replyTo ? list.find((c) => c.id === replyTo) : undefined;
  if (parent) parent.replies = [...parent.replies, comment];
  else commentState.set(seed.number, [...list, comment]);
  return comment;
}

export function handleToggleLaunchpadUpvote(a: InvokeArgs): LaunchpadUpvoteResult {
  warnUnknownArgs(['discussionRepo', 'discussionNumber', 'subjectId', 'currentlyUpvoted'], a, 'toggle_launchpad_upvote');
  const number = argNum(a, 'discussionNumber') ?? 0;
  const seed = seedByNumber(number);
  if (!seed) throw new Error('讨论不存在');
  const current = upvotes(seed);
  const want = a.currentlyUpvoted !== true;
  const next = {
    count: Math.max(0, current.count + (want === current.mine ? 0 : want ? 1 : -1)),
    mine: want,
  };
  upvoteState.set(seed.number, next);
  return {
    subject_id: argStr(a, 'subjectId') || `D_demo_${seed.number}`,
    upvote_count: next.count,
    viewer_has_upvoted: next.mine,
    mode: 'upvote',
  };
}
