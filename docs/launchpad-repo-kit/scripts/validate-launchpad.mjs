#!/usr/bin/env node
/**
 * validate-launchpad.mjs
 *
 * 校验 launchpad.json：结构（与 schema/launchpad.schema.json 同口径）+ 跨字段业务不变量：
 * 1. items.id 全局唯一，且等于 (forge, forge_host, owner, repo) 推导的规范标识；
 * 2. pinned.id 不重复且全部引用 items；pinned 至多 4 条；
 * 3. 时间字段均为合法 ISO-8601 UTC；
 * 4. 协议命中 37 项 OSI 名单；图标仅允许空串或 https://；maker_note 单行 1..=140 字符。
 *
 * 用法：node scripts/validate-launchpad.mjs [path/to/launchpad.json]
 * 无参数时校验仓库根 launchpad.json；出错时逐条打印并以退出码 1 结束。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORY_KEYS,
  FORGE_HOSTS,
  MAKER_NOTE_MAX,
  MANIFEST_VERSION,
  PIN_TIERS,
  PLATFORMS,
  SPOTLIGHT_MAX_SLOTS,
  charCount,
  deriveId,
  isIsoUtc,
  isOsiLicense,
} from './lib/shared.mjs';

const REQUIRED_STRINGS = [
  'id', 'name', 'owner', 'repo', 'forge', 'forge_host', 'icon', 'icon_bg', 'description',
  'maker_note', 'category', 'category_name', 'license', 'latest_version', 'launched_at',
  'discussion_repo', 'discussion_url',
];
const REQUIRED_COUNTS = ['stars', 'stars_7d_delta', 'forks', 'discussion_comments_count', 'discussion_upvotes'];
const OPTIONAL_STRINGS = ['description_en', 'maker_note_en', 'latest_release_at', 'homepage', 'discussion_node_id'];
const KNOWN_ITEM_KEYS = new Set([
  ...REQUIRED_STRINGS, ...REQUIRED_COUNTS, ...OPTIONAL_STRINGS, 'platforms', 'maker', 'discussion_number',
]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

function validateItem(item, i, errors) {
  const at = `items[${i}]`;
  if (!isObj(item)) {
    errors.push(`${at}: 必须是对象`);
    return;
  }
  for (const key of Object.keys(item)) {
    if (!KNOWN_ITEM_KEYS.has(key)) errors.push(`${at}: 未知字段 ${key}`);
  }
  for (const key of REQUIRED_STRINGS) {
    if (typeof item[key] !== 'string') errors.push(`${at}.${key}: 必填字符串`);
  }
  for (const key of OPTIONAL_STRINGS) {
    if (key in item && typeof item[key] !== 'string') errors.push(`${at}.${key}: 必须是字符串`);
  }
  for (const key of REQUIRED_COUNTS) {
    if (!isNonNegInt(item[key])) errors.push(`${at}.${key}: 必须是非负整数`);
  }
  if (!(Number.isInteger(item.discussion_number) && item.discussion_number > 0)) {
    errors.push(`${at}.discussion_number: 必须是正整数`);
  }
  for (const key of ['name', 'owner', 'repo', 'description', 'latest_version']) {
    if (typeof item[key] === 'string' && !item[key].trim()) errors.push(`${at}.${key}: 不能为空`);
  }
  if (!(item.forge in FORGE_HOSTS)) errors.push(`${at}.forge: 仅支持 ${Object.keys(FORGE_HOSTS).join(' / ')}`);
  if (typeof item.id === 'string') {
    if (item.id !== item.id.toLowerCase()) errors.push(`${at}.id: 必须小写`);
    const derived = deriveId(item);
    if (item.id !== derived) errors.push(`${at}.id: 应为 ${derived}`);
  }
  if (typeof item.icon === 'string' && item.icon !== '' && !/^https:\/\/\S+$/.test(item.icon)) {
    errors.push(`${at}.icon: 仅允许空串或 https:// 直链（禁止 http:// 与 data:）`);
  }
  if (typeof item.maker_note === 'string') {
    const n = charCount(item.maker_note);
    if (n < 1 || n > MAKER_NOTE_MAX) errors.push(`${at}.maker_note: 长度须为 1..=${MAKER_NOTE_MAX}（当前 ${n}）`);
    if (/[\r\n\u0000-\u001f]/.test(item.maker_note)) errors.push(`${at}.maker_note: 不得含换行或控制字符`);
  }
  if (typeof item.maker_note_en === 'string' && charCount(item.maker_note_en) > MAKER_NOTE_MAX * 2) {
    errors.push(`${at}.maker_note_en: 过长`);
  }
  if (!isObj(item.maker)) {
    errors.push(`${at}.maker: 必填对象`);
  } else {
    for (const key of ['login', 'avatar_url', 'html_url']) {
      if (typeof item.maker[key] !== 'string' || !item.maker[key].trim()) errors.push(`${at}.maker.${key}: 必填字符串`);
    }
    if (typeof item.maker.avatar_url === 'string' && !/^https:\/\//.test(item.maker.avatar_url)) {
      errors.push(`${at}.maker.avatar_url: 仅允许 https://`);
    }
  }
  if (!CATEGORY_KEYS.includes(item.category)) errors.push(`${at}.category: 非标准分类 ${item.category}`);
  if (!isOsiLicense(item.license)) errors.push(`${at}.license: ${item.license} 不在 OSI 白名单`);
  if (!Array.isArray(item.platforms) || item.platforms.length === 0) {
    errors.push(`${at}.platforms: 必须是非空数组`);
  } else {
    if (new Set(item.platforms).size !== item.platforms.length) errors.push(`${at}.platforms: 存在重复`);
    for (const p of item.platforms) {
      if (!PLATFORMS.includes(p)) errors.push(`${at}.platforms: 未知平台 ${p}`);
    }
  }
  for (const key of ['launched_at', 'latest_release_at']) {
    if (key in item && !isIsoUtc(item[key])) errors.push(`${at}.${key}: 非法 ISO-8601 时间`);
  }
  if (typeof item.discussion_repo === 'string' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.discussion_repo)) {
    errors.push(`${at}.discussion_repo: 必须是 owner/repo`);
  }
  if (typeof item.discussion_url === 'string' && !/^https:\/\/github\.com\/[^/]+\/[^/]+\/discussions\/\d+$/.test(item.discussion_url)) {
    errors.push(`${at}.discussion_url: 必须是 GitHub Discussion 地址`);
  }
}

/** 校验清单对象，返回错误列表（空即通过）。 */
export function validateLaunchpad(manifest) {
  const errors = [];
  if (!isObj(manifest)) return ['根节点必须是对象'];
  if (manifest.version !== MANIFEST_VERSION) errors.push(`version: 必须为 ${MANIFEST_VERSION}`);
  if (!isIsoUtc(manifest.generated_at)) errors.push('generated_at: 非法 ISO-8601 时间');
  if (typeof manifest.discussions_repo !== 'string' || !manifest.discussions_repo.includes('/')) {
    errors.push('discussions_repo: 必须是 owner/repo');
  }
  const items = Array.isArray(manifest.items) ? manifest.items : (errors.push('items: 必须是数组'), []);
  const pinned = Array.isArray(manifest.pinned) ? manifest.pinned : (errors.push('pinned: 必须是数组'), []);

  const ids = new Set();
  items.forEach((item, i) => {
    validateItem(item, i, errors);
    if (isObj(item) && typeof item.id === 'string') {
      if (ids.has(item.id)) errors.push(`items[${i}].id: 重复 ${item.id}`);
      ids.add(item.id);
    }
  });

  if (pinned.length > SPOTLIGHT_MAX_SLOTS) errors.push(`pinned: 至多 ${SPOTLIGHT_MAX_SLOTS} 条（当前 ${pinned.length}）`);
  const pinnedIds = new Set();
  pinned.forEach((pin, i) => {
    const at = `pinned[${i}]`;
    if (!isObj(pin)) {
      errors.push(`${at}: 必须是对象`);
      return;
    }
    if (typeof pin.id !== 'string' || !ids.has(pin.id)) errors.push(`${at}.id: 引用不存在的条目 ${pin.id}`);
    if (pinnedIds.has(pin.id)) errors.push(`${at}.id: 重复 ${pin.id}`);
    pinnedIds.add(pin.id);
    if (!isIsoUtc(pin.pin_until)) errors.push(`${at}.pin_until: 非法 ISO-8601 时间`);
    if (!PIN_TIERS.includes(pin.pin_tier)) errors.push(`${at}.pin_tier: 仅支持 ${PIN_TIERS.join(' / ')}`);
    if (!(Number.isInteger(pin.pin_order) && pin.pin_order >= 1 && pin.pin_order <= SPOTLIGHT_MAX_SLOTS)) {
      errors.push(`${at}.pin_order: 必须是 1..=${SPOTLIGHT_MAX_SLOTS} 的整数`);
    }
  });
  return errors;
}

export function validateFile(file) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return [`无法读取或解析 ${file}: ${e.message}`];
  }
  return validateLaunchpad(manifest);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = path.resolve(process.argv[2] || path.join(rootDir, 'launchpad.json'));
  const errors = validateFile(file);
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    console.error(`\n${errors.length} 个问题，launchpad.json 校验未通过`);
    process.exit(1);
  }
  console.log('✓ launchpad.json 校验通过');
}
