# Issue 32: 类型卫生：as unknown / as any 收口 + tsconfig 加严

Status: resolved
Priority: P3（类型安全）
来源: 2026-10-21 全项目审查 · 前端核心分片

## 描述

1. 全 src `as any`/`as unknown` 共 43 处；最重的是
   `src/services/trends/enrich.ts:227-800` 内 15 处
   `as unknown as Record<string,unknown>` 重复 cast 读 wire 松散字段。
2. `src/views/SettingsView.tsx:203,209`：`onUpdateSetting('font_size', id as any)` 断言
   绕类型。
3. `src/app/hooks/useDeepLink.ts:48`：`(window as any).dispatchZStoreDeepLink` 全局挂
   载，无类型与卸载清理。
4. `tsconfig.json`：strict 开但无 `noUncheckedIndexedAccess`。

## 修复方向

- enrich.ts 抽类型化 accessor（如 `readStr(obj, key)`/`readNum`），15 处 cast 收口到
  一个模块；SettingsView 用字面量联合类型；window 挂载补 `declare global` 类型。
- 评估开启 `noUncheckedIndexedAccess`（预计引发一批索引访问修复，可单独一轮做）。

## Comments

- enrich.ts 收口：新增模块内 `readLoose(obj, key)`/`writeLoose(obj, key, value)`
  两个 accessor（doc 注明「本模块唯一 cast 点」与 wire 松散数据语义），15 处
  `as unknown as Record<string,unknown>` + 4 处 `as unknown as { is_stale }` +
  2 处 `as unknown`（latest_version）共 18 处 occurrence 全部改走 accessor，
  enrich.ts 现零 `as unknown`/`as any`。语义逐字对齐：仍 cast 成 unknown 后由
  调用方按值判定（richStr/Number/===），diff/merge 行为零变化。
- SettingsView：`font_size`/`update_frequency` 两个 handler 参数与下游两个 section
  （AppearanceSection/UpdatesRulesSection）的 props 一并收紧为
  `AppSettings['font_size']`/`AppSettings['update_frequency']` 字面量联合——
  SegmentedControl 本就泛型，props 去掉 `string` 放宽后 T 自动推窄，
  两处 `as any` 直接删除、无新 cast 引入。
- useDeepLink：补 `declare global { interface Window { dispatchZStoreDeepLink?:
  (rawUrl: string) => void } }`（挂载点唯一类型声明处），两处 `(window as any)`
  删除；卸载清理（delete）工单描述有误实际已有，保持原样。
- 本张共消除 22 处（enrich 18 + SettingsView 2 + useDeepLink 2，occurrence 计）；
  全 src 生产码现存 41 处（审查时点 43，前期批次已消减），剩余大头为
  useAppSettings.ts 设置合并循环 6 处 `as any`（与 enrich 同型动态键模式，可复用
  accessor 思路）与 i18n.ts 1 处 `navigator.userLanguage`——非本张点名范围，建议
  后续轮次按同法收口。
- **`noUncheckedIndexedAccess` 评估结论：单独一轮做。** 临时开启实测 tsc
  145 个错误（涉及 TrendsView/useTrendEnrichment 等索引访问热点，多数需语义判断
  加守卫而非机械修），按工单「可单独一轮做」与批次授权不在本张硬吃；tsconfig
  保持不变，后续轮次以本数字为基线拆分修复。
- 测试：trends + views 全量 28 文件 393 用例通过；`pnpm build`（tsc + vite）绿。
