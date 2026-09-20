//! 解析器兼容层。
//!
//! 原单体文件 `resolver.rs`（731 行）的纯代码结构拆分：
//! - `super::lnk_target`: MS-SHLLINK 二进制解析 (`resolve_lnk_target`) 与测试固件。
//! - `super::display_icon`: DisplayIcon 清理、安装包/缓存过滤与 exe 搜索。
//! - `super::executable`: 可执行程序 / 安装路径解析。
//!
//! 所有公共入口依然保持为 `super::AppScanner` 的固有方法且签名完全一致；
//! 该模块仅重新导出拆分后的接口。

pub use super::display_icon;
pub use super::executable;
pub use super::lnk_target;
