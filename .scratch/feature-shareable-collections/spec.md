# Feature Spec: 可分享的「应用清单 / 专题合集」深链（`zstore://collection`）与批量预览安装

> 状态：Implemented
> 关联契约：`CONTEXT.md`（D1 纯粹开源、D2 零服务器成本、D3 零信任完整性防篡改、D4 Linear 去彩单色界面）、`docs/count-display.md`（数量显示规范）、ADR-0004（流式安装与 SHA-256 校验）、ADR-0010（规范应用标识）、ADR-0027（单仓富卡隔离缓存 `repo_card_cache`）。

---

## 1. 核心目标与定位

让「我的装机清单」和「收藏精选列表」变成**无中心服务器依赖的社交传播载体**：

1. **发送端（生成合集深链与 Markdown 清单）**：
   - 用户可在「我的应用（`InstalledView`）」或「收藏（`FavoritesView`）」勾选最多 `30` 款开源应用，填写合集名称与一句话备注，一键复制 `zstore://collection?title=...&note=...&ids=...` 分享深链或排版精美的 GitHub Markdown 推荐清单。
2. **接收端（合集预览弹窗与显式批量安装）**：
   - 接收方点击外部 `zstore://collection?...` 深链唤起客户端时，**绝不静默自动安装**，而是弹出基于 `<ModalShell>` 的 `<CollectionPreviewModal>`：零网络水合展示合集中的所有应用、本机已安装/可安装状态与平台兼容标识，支持勾选后一键顺序批量安装或一键全部加入收藏。

---

## 2. 架构边界与安全约束

1. **深链安全门禁（防恶意 URI 与静默安装）**：
   - 严格沿用 `src-tauri/src/deeplink.rs` 的 `MAX_DEEPLINK_LEN = 2048` 长度上限与 NUL 控制字符（`%00`）拒绝规则；
   - `ids` 列表每项必须经过 `crate::forge::canonical_app_id` 校验与小写去重，非法坐标直接丢弃，有效条目上限 `MAX_COLLECTION_APPS = 30`；若清洗后 `app_ids` 为空则整条深链无效（返回 `None`）；
   - `title` 与 `note` 剥除全部控制字符并分别截断至 `60` / `140` 个 Unicode 字符（由 React 文本节点安全渲染，禁止 `dangerouslySetInnerHTML`）；
   - 触发深链只打开预览弹窗，所有安装动作均需用户在弹窗内主动勾选并点击「安装选中项」，且每款软件的下载校验依旧严格走 SHA-256 校验与无校验弹窗确认（D3）。
2. **零服务端全本地水合**：
   - `resolve_collection_apps` 优先读取内存合并目录 `CatalogService`（远端精选 + 本地收录 overlay），未收录项回退本地 SQLite `repo_card_cache` / `app_details_cache`，仍未命中则按合法坐标生成最小占位 `AppSummary`（`is_cataloged = Some(false)`），不因打开合集弹窗触发 N 次并发 API 风暴。
3. **跨视图与弹窗层次**：
   - `<CollectionPreviewModal>` 与 `<CollectionShareModal>` 统一使用 `<ModalShell>`（`base` 层），遵循 D4 Linear 去彩单色规范与 `<CountBadge>` 数量规范。

---

## 3. 后端设计（`src-tauri/src/`）

### 3.1 `zstore://collection` 协议解析（`src-tauri/src/deeplink.rs`）

1. **`DeepLinkAction` 新增变体**：
   ```rust
   Collection {
       title: String,
       note: Option<String>,
       app_ids: Vec<String>,
   }
   ```
2. **支持格式**：
   - 标准查询形态：`zstore://collection?title=Rust+%E8%A3%85%E6%9C%BA&note=%E5%BC%80%E5%8F%91%E5%BF%85%E5%A4%87&ids=rustdesk/rustdesk,localsend/localsend`
   - 简写路径形态：`zstore://collection/rustdesk/rustdesk,localsend/localsend`（`ids` 在 path，可选 `title`/`note` 在 query）
3. **参数清洗纯函数**：
   - `MAX_COLLECTION_APPS: usize = 30`、`MAX_COLLECTION_TITLE_CHARS: usize = 60`、`MAX_COLLECTION_NOTE_CHARS: usize = 140`；
   - 拆分 `ids`（支持逗号 `,` 或 `%2C`），对每项先 `decode_payload` 并去除空白，再经 `crate::forge::canonical_app_id` 归一化，去重保持原顺序，超过 `30` 个截断；
   - 合法 `app_ids.is_empty()` 时返回 `None`；
   - `title` 去除控制字符、合并连续空白、限长 `60` 字符（空串由前端按默认标题渲染）；`note` 同口径清洗、限长 `140` 字符（为空时置 `None`）。

### 3.2 批量本地水合 IPC（`resolve_collection_apps`）

1. **命令签名（`src-tauri/src/commands/catalog_detail.rs` & `src-tauri/src/lib.rs`）**：
   ```rust
   #[tauri::command(rename_all = "camelCase")]
   pub fn resolve_collection_apps(
       state: State<'_, AppState>,
       app_ids: Vec<String>,
   ) -> AppResult<Vec<AppSummary>>
   ```
2. **解析链路**：
   - 入口对 `app_ids` 执行 `canonical_app_id` 归一化、去重并截取前 `30` 条；
   - 在单次 `CatalogService` 与 `db` 读取中按序组装每个 ID：
     1. 命中 `CatalogService` 合并目录 → 投影 `AppSummary`（自带 `stamp_merged` 与 `alternatives`）；
     2. 未命中目录 → 批量查询 `db.get_repo_cards_batch` 与 `db.get_app_detail` 缓存，若命中则投影并通过 `CatalogService::stamp_summary` 标为 `is_cataloged = Some(false)`；
     3. 均未命中 → 基于 `RepositoryUrlParser::parse` 合成最小占位 `AppSummary`（`name = repo`、`owner`、`repo`、`forge`、`forge_host`、`is_cataloged = Some(false)`）；
   - 统一经 `resolve_confirmed_icon_from_db` 叠加本地确认图标。

---

## 4. 前端设计（`src/`）

### 4.1 协议与 API 桥接
- `src/services/api.ts`：`CMD.resolveCollectionApps = 'resolve_collection_apps'`。
- `src/services/api/catalog.ts`：新增 `resolveCollectionApps(appIds: readonly string[]): Promise<AppSummary[]>`（仅传 `{ appIds: [...] }` camelCase 参数）。
- `src/types/index.ts`：扩展 `DeepLinkAction` 联合类型增加 `{ action: 'collection'; payload: { title: string; note?: string | null; app_ids: string[] } }`，新增 `CollectionModalData` 前端视图接口。
- `src/app/hooks/useDeepLink.ts`：新增 `openCollection?: (collection: CollectionModalData) => void` 路由回调，处理 `action.action === 'collection'`；并在 `src/demo/handlers/catalog.ts` & `src/demo/tauri-mock.ts` 同步实现 `collection` 深链解析与 `resolve_collection_apps` Mock。

### 4.2 接收端：`<CollectionPreviewModal>`（`src/components/CollectionPreviewModal.tsx`）
- 挂载于 `src/App.tsx`（当 `activeCollection !== null` 时渲染）；
- 打开时调用 `tauriApi.resolveCollectionApps(activeCollection.app_ids)` 获取应用概要列表，同时入队 `queueAssembledRowIcons` 后台补齐确认图标，对缺失平台且未收录的行可按需触发 `onLoadUncatalogedDetail` 或点击行打开 `AppDetailModal`；
- **列表交互**：
  - 每行展示 `<AppIconFrame size="sm">`、应用名、仓库坐标（`owner/repo`）、一句话简介、平台图标与开源协议标签；
  - 若 `installedIds` 命中该 `id`，行右展示单色 `.status-tag` `已安装` 且默认不勾选；否则若支持当前宿主平台，默认勾选；
  - 顶栏显示合集标题（缺省为 `t('collection.default_title')`）、可选备注与 `<CountBadge value={items.length} />`；
- **底部操作栏**：
  - 「全选未安装 / 取消全选」切换；
  - 「全部加入收藏」按钮（遍历未收藏项调用 `onToggleFavorite`，或跳过已收藏项）；
  - 主按钮「批量安装选中项」带 `<CountBadge value={selectedInstallIds.length} hideZero />`，点击后顺序调用既有 `onInstallApp(id)`：
    - 展示当前安装进度（如正在安装第 `k / N` 款、单条失败不中断其余项、结束后 Toast 汇总成功/失败数）；
    - 若某项命中 `unverifiedInstallPrompt`（无 SHA-256 校验清单），正常由既有的 `InstallConfirmDialog` 确认机制接管。

### 4.3 发送端：`<CollectionShareModal>`（`src/components/CollectionShareModal.tsx`）
- **入口位置**：
  - `src/views/InstalledView.tsx` 顶栏 `<ManageHeader actions={...}>` 增加「分享清单」次按钮（已装应用数量 `> 0` 时可用）；
  - `src/views/FavoritesView.tsx` 导航栏右侧（`local` / `watched` 签下且当前列表非空时）增加「分享清单」次按钮。
- **弹窗内容**：
  - 合集标题输入框（限 `60` 字符，支持预设占位如「我的开源软件清单」）与可选一句话备注（限 `140` 字符）；
  - 应用多选清单（展示来源列表应用，默认预选前 `15` 款未隐藏项，支持页内筛选与增删勾选，实时展示已选计数 `<CountBadge value={selectedIds.length} />` / 上限 `30`）；
  - 实时预览并一键复制（调用 `copyTextToClipboard` 并展示 `useTransientFeedback` 成功状态）：
    1. **复制 `zstore://` 深链**：自动编码生成 `zstore://collection?title=...&note=...&ids=...`（若总长度逼近 `2048` 字节限制，在 UI 层提示截断或精简备注以防超限）；
    2. **复制 Markdown 推荐清单**：生成包含标题、备注、应用表格（名称、仓库、协议、简介）以及 `zstore://collection?...` 一键打开提示的规范 Markdown。

---

## 5. 测试与验收门槛

1. **Rust 单测**：
   - `deeplink.rs`：测试标准查询与路径简写解析、去重、`30` 上限截断、非法 ID 过滤、全空拒绝、`%00` NUL 拦截、`2048` 超长拦截、`title/note` 控制字符剥除与截断；
   - `resolve_collection_apps`：测试已收录、仅 `repo_card_cache` 命中、完全未知坐标合成占位三种情况并验证保序输出。
2. **前端单测**：
   - `CollectionPreviewModal.test.tsx`：已安装禁用默认勾选、批量勾选安装顺序调用与进度状态、一键加入收藏；
   - `CollectionShareModal.test.tsx`：深链 URL 编码正确性（可往返被解析）、2048 字符超限提醒、Markdown 生成格式、`<CountBadge>` 规范；
   - `cmdAlignment.test.ts`、`ipcArgsNaming.test.ts`、`countDisplay.test.ts` 全绿。
