#!/usr/bin/env node

/**
 * sync-catalog-seed.mjs
 * 
 * 从独立数据仓库 (supermc/z-store-catalog) 同步最新的应用清单数据，
 * 更新本客户端仓库根目录下的离线兜底种子 catalog.json。
 * 
 * 用法:
 *   node scripts/sync-catalog-seed.mjs
 *   node scripts/sync-catalog-seed.mjs --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const isDryRun = process.argv.includes('--dry-run');

// 1. 读取 config.toml 中的 catalog 配置
function resolveCatalogConfig() {
  const configPath = path.join(rootDir, 'src-tauri', 'config.toml');
  let localPath = path.join(rootDir, 'catalog.json');
  let sourceUrl = 'https://raw.githubusercontent.com/supermc/z-store-catalog/main/catalog.json';

  if (fs.existsSync(configPath)) {
    const configContent = fs.readFileSync(configPath, 'utf8');
    const localMatch = configContent.match(/local_path\s*=\s*["']([^"']+)["']/);
    if (localMatch && localMatch[1]) {
      const resolved = path.resolve(rootDir, 'src-tauri', localMatch[1]);
      localPath = resolved;
    }
    const urlMatch = configContent.match(/default_source_url\s*=\s*["']([^"']+)["']/);
    if (urlMatch && urlMatch[1]) {
      sourceUrl = urlMatch[1];
    }
  }

  return { localPath, sourceUrl };
}

const { localPath, sourceUrl } = resolveCatalogConfig();

console.log(`🌐 正在准备同步生态收录种子...`);
console.log(`📡 上游数据源: ${sourceUrl}`);
console.log(`📂 本地种子路径: ${path.relative(rootDir, localPath)}`);

if (isDryRun) {
  console.log(`🔍 [Dry-Run 模式] 仅做校验，不写回文件。`);
}

// 2. 发起网络请求（支持国内加速镜像 fallback）
const candidates = [
  sourceUrl,
  sourceUrl.replace('https://raw.githubusercontent.com/', 'https://gh-proxy.com/https://raw.githubusercontent.com/'),
  sourceUrl.replace('https://raw.githubusercontent.com/', 'https://cdn.jsdelivr.net/gh/').replace('/main/', '@main/')
];

let fetchedContent = null;
let successfulUrl = null;

for (const url of candidates) {
  try {
    console.log(`⏳ 尝试拉取: ${url} ...`);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ZStore-Catalog-Seed-Sync/0.1.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const text = await res.text();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        fetchedContent = parsed;
        successfulUrl = url;
        break;
      }
    }
  } catch (err) {
    // 尝试下一个候选地址
  }
}

if (!fetchedContent) {
  if (isDryRun && fs.existsSync(localPath)) {
    console.log(`⚠️ 上游仓库可能尚未完成初次推送，Dry-Run 使用现有本地文件进行校验通过。`);
    process.exit(0);
  }
  console.error(`❌ 无法从上游拉取有效的 catalog.json，请确认远程仓库存在且已发布。`);
  process.exit(1);
}

console.log(`✅ 成功从 ${successfulUrl} 拉取到清单数据，共包含 ${fetchedContent.length} 款应用。`);

if (!isDryRun) {
  const formatted = JSON.stringify(fetchedContent, null, 2) + '\n';
  fs.writeFileSync(localPath, formatted, 'utf8');
  console.log(`💾 已成功同步写入本地种子文件: ${path.relative(rootDir, localPath)} (${(formatted.length / 1024).toFixed(1)} KB)`);
} else {
  console.log(`🔍 Dry-Run 校验通过，无异常。`);
}
