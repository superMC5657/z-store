//! Resolver compatibility surface.
//!
//! Pure-move split of the former monolithic `resolver.rs` (731 lines):
//! - `super::lnk_target`: MS-SHLLINK binary parsing (`resolve_lnk_target`) + fixture tests.
//! - `super::display_icon`: DisplayIcon cleanup, installer/cache filter, exe search.
//! - `super::executable`: executable / installed-path resolution.
//!
//! All public entry points remain inherent methods on `super::AppScanner`
//! with identical signatures; this module only re-exports the split surface.

pub use super::display_icon;
pub use super::executable;
pub use super::lnk_target;
