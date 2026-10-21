# Feature Spec: 细粒度版本控制与签名安全防御 (feature-update-ctrl)

> 借鉴 Komi Store (Skipped Updates) 与 Z-Store PRD FR-4.4 / D3，为用户提供版本跳过、版本锁定、隐藏仓库以及 SHA-256 防篡改能力。

## 1. 目标与范围

- **更新控制策略**：支持用户为特定软件配置“跳过此版本 (Skip Version)”、“永久锁定当前版本 (Freeze Version)”以及“在发现/更新中隐藏 (Hide Repo)”。
- **安全防篡改升级**：除现有的 SHA-256 流式哈希外，哈希不符直接销毁临时文件并阻断安装，强化供应链防篡改防御。
- **界面管理面板**：在更新中心卡片提供直接跳过选项，并在设置中提供“已忽略/已锁定软件规则管理”。

## 2. 实施 Issue 清单

- `01-sqlite-update-rules-table.md`: SQLite 新增版本策略表与查询过滤逻辑
- `02-authenticode-signature-verifier.md`: Windows 平台安装包完整性核验（仅 SHA-256）
- `03-skip-version-ui-controls.md`: 更新中心跳过菜单与设置中心规则管理视图

> 范围外已实现注记：图标双表（`icon_cache_meta` + `app_icon_cycles`，`db/schema.rs:100-122`）与轮换分流已落地，本特性不重复覆盖。
