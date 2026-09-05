#!/usr/bin/env node

/**
 * refresh-catalog.mjs
 * 
 * 自动保鲜收录清单脚本：
 * 批量调用 GitHub / Codeberg API，获取各收录应用的最新 Stars、Forks 与 Release Tag，
 * 并自动同步更新根目录与 src-tauri/src/ 下的 catalog.json。
 * 
 * 可在本地运行：node scripts/refresh-catalog.mjs
 * 也可在 GitHub Actions 定时任务中全自动运行。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const catalogPaths = [
  path.join(rootDir, 'catalog.json'),
  path.join(rootDir, 'src-tauri', 'src', 'catalog.json'),
];

// 选择存在的主文件作为基准读取
const primaryPath = catalogPaths.find(p => fs.existsSync(p)) || catalogPaths[0];

if (!fs.existsSync(primaryPath)) {
  console.error(`❌ 未找到收录清单文件: ${primaryPath}`);
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(primaryPath, 'utf8'));
console.log(`📋 开始保鲜收录库，共 ${catalog.length} 款应用...`);

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const headers = {
  'User-Agent': 'ZStore-Catalog-Refresher/0.1.0',
  'Accept': 'application/vnd.github.v3+json',
};
if (token) {
  headers['Authorization'] = `token ${token}`;
  console.log('🔑 使用环境变量中的 GitHub Token 进行高速未限流拉取');
} else {
  console.log('⚠️ 未检测到 GITHUB_TOKEN，将使用公开匿名限额 (60次/小时)');
}

let updatedCount = 0;

for (let i = 0; i < catalog.length; i++) {
  const item = catalog[i];
  const { owner, repo, forge } = item;

  // 默认作为 GitHub 仓库处理
  if (!forge || forge === 'github') {
    try {
      // 1. 获取最新 Star / Fork / Description / License
      const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
      const repoRes = await fetch(repoUrl, { headers });

      if (repoRes.status === 200) {
        const repoData = await repoRes.json();
        const oldStars = item.stars;
        const newStars = repoData.stargazers_count ?? oldStars;
        const newForks = repoData.forks_count ?? item.forks;

        item.stars = newStars;
        item.forks = newForks;
        if (repoData.license?.spdx_id) {
          item.license = repoData.license.spdx_id;
        }

        // 2. 获取最新 Release Tag
        const releaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
        const relRes = await fetch(releaseUrl, { headers });
        if (relRes.status === 200) {
          const relData = await relRes.json();
          if (relData.tag_name) {
            item.default_version = relData.tag_name;
          }
        }

        console.log(`[${i + 1}/${catalog.length}] ✅ ${item.name} (${owner}/${repo}): ⭐ ${oldStars} ➔ ${item.stars}, 🏷️ ${item.default_version}`);
        updatedCount++;
      } else if (repoRes.status === 403 || repoRes.status === 429) {
        console.warn(`⚠️ [${i + 1}/${catalog.length}] 触发 API 速率限制 (HTTP ${repoRes.status})，停止后续抓取`);
        break;
      } else {
        console.warn(`⚠️ [${i + 1}/${catalog.length}] ${item.name} 查询失败 (HTTP ${repoRes.status})`);
      }
    } catch (err) {
      console.error(`❌ [${i + 1}/${catalog.length}] ${item.name} 请求异常:`, err.message);
    }
  }

  // 礼貌间隔，避免并发压测
  await new Promise(r => setTimeout(r, 150));
}

// 格式化回写到两个目录下的 catalog.json
const outputJson = JSON.stringify(catalog, null, 2) + '\n';
for (const p of catalogPaths) {
  if (fs.existsSync(path.dirname(p))) {
    fs.writeFileSync(p, outputJson, 'utf8');
    console.log(`💾 已写回并更新: ${path.relative(rootDir, p)}`);
  }
}

console.log(`\n🎉 收录库保鲜完成！成功更新 ${updatedCount} / ${catalog.length} 款应用的最新基线数据。`);
