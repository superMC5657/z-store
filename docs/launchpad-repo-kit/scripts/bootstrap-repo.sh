#!/usr/bin/env bash
# 幂等初始化 z-store-launchpad 仓库标签，并打印需要在网页上手动完成的核对清单。
# 用法：GH_REPO=superMC5657/z-store-launchpad scripts/bootstrap-repo.sh
set -euo pipefail

REPO="${GH_REPO:-superMC5657/z-store-launchpad}"

if ! command -v gh >/dev/null 2>&1; then
  echo "需要 GitHub CLI (gh)：https://cli.github.com/" >&2
  exit 1
fi

# name|color|description
LABELS=(
  "launchpad-submission|5319e7|开源广场投稿"
  "validated|0e8a16|自动体检通过"
  "needs-changes|d93f0b|自动体检未通过，需要作者修改"
  "approved|1d76db|维护者准入：免费上架最新上架池"
  "pinned-7d|fbca04|维护者准入：置顶推荐 7 天（赞助）"
  "pinned-14d|fbca04|维护者准入：置顶推荐 14 天（赞助）"
  "pinned-30d|fbca04|维护者准入：置顶推荐 30 天（赞助）"
  "featured-7d|c5def5|维护者准入：编辑精选置顶 7 天"
  "published|0e8a16|已上架并完成通知"
)

for entry in "${LABELS[@]}"; do
  IFS='|' read -r name color description <<<"$entry"
  gh label create "$name" --repo "$REPO" --color "$color" --description "$description" --force >/dev/null
  echo "✓ label: $name"
done

cat <<CHECKLIST

接下来请在网页上完成（只需一次）：
  1. https://github.com/$REPO/settings → Features → 勾选 Discussions
  2. https://github.com/$REPO/discussions/categories → 新建分类 "Launches"（格式选 Announcement 或 Open-ended discussion）
  3. https://github.com/$REPO/settings/actions → Workflow permissions 选择 "Read and write permissions"
  4. 确认 main 分支保护允许 github-actions[bot] 推送（或为其配置 bypass）
CHECKLIST
