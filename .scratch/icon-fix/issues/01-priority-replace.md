# 01: 迟到高优图标可替换低优

**What to build:** 搜索与趋势流式补齐时，后到的品牌库图标可把同一规范应用标识的低优图替换为高优真图，用户最终看到高优图而非先到者。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] 同一应用先呈现低优图/徽章，后到高优图时可升级，不再丢弃
- [x] 已收录恒定官方图行为不变，未收录轮换不受影响

## Answer

根因：前端唯一收口 `src/services/iconStore.ts` 的 `admitIconHit` 纯L单调门控数值比较写反（`Math.max` 取大者胜 + `pureLevel < currentMax` 判 stale），把数字大的低优（L3仓库/L4 README）当高优，导致同一规范应用标识先到 L3/L4 后，后到的 L2品牌库真图被 `level-stale` 丢弃；同时 L1官方（数字最小）反而最弱，会被低优顶掉。后端 `IconFetch`（`src-tauri/src/github/icon_fetch.rs:229 fetch_icons_stream` 经 `probe_single_live` L2→L3 快命中即返）本就 L2 优先，无需改动。

改动（只碰 01 范围，后端零改动）：
- `src/services/iconStore.ts`：新增导出 `compareIconPriority(a, b)`（数字越小优先级越高：L1官方 > L2品牌库 > L3仓库 > L4 README；L5显式徽章优先级最高以保持轮换门控语义 L2→L5接受/L5→L2判 stale）；`admitIconHit` 内单调门控改用该函数（别名取最优值，更差判 `level-stale`，受理即采用 incoming 升级或同级覆盖），并更新三处注释（module depth、单调记忆、门控说明）。`via` 正交、`data:` 纯内存、m2不推进记忆、L5空徽章唯一写口与世代门控均不变。
- `src/views/HomeView.search-icon.test.tsx`：翻转两处锁死旧语义的断言为新语义——首刷回声窗改为 L3先到/L2后到升级且 L2→L3判 stale；纯L单调改为 L4→L2接受升级、L2→L4（via=m2）判 stale。回声串号门控与 L2→L5/L5→L2 断言不受影响（L5最高保持原语义）。
- 已收录恒定官方图：L1 在新比较下为 1..4 中最高优，后到 L2/L3/L4 不再顶掉 L1；收录行本就不进流式 jobs（`catalog_search.rs` 按精选收录库过滤），行为不变。未收录轮换：L5空徽章走 `applyBadgeHit` 独立分支（清记忆+扇出，不经单调门控），语义不变；轮换后端（`next_cycle_level`/`first_available_level`）未动。

验证：
- `npx vitest run src/services/iconStore.deepen.test.ts src/services/iconStore.l5badge.test.ts src/services/iconStore.patch-red.test.ts src/views/HomeView.search-icon.test.tsx`：4文件22项全过。
- `npx vitest run src/components/AppDetailModal/Header.l5cycle.test.tsx src/services/trends/cache.test.ts`：19项全过（轮换/L5与榜缓存无回归）。
- `npx tsc --noEmit`：通过。后端未改，未跑 cargo test。
