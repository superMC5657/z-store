/**
 * 资产区网络门禁（单一来源）。
 *
 * 仅已安装应用 / 更新中心 / 我的收藏三个资产区默认 DB-only，
 * 网络仅经显式手动动作：更新检查按钮（force_refresh=true）、
 * 收藏行加载详情按钮、图标轮换按钮。
 *
 * 其余区域自动联网：趋势进 tab 抓取、发现页后端分页 + 哨兵续拉、
 * 平台懒回填、搜索提交在线路径、详情后台 ETag 复核、README 页签拉取、
 * 启动图标预解码。仅需 DB 读的命令（搜索本地/getInstalledApps/
 * 收藏记录/更新快照等）保持自动。
 */
export const MANUAL_ONLY_NETWORK = true;
