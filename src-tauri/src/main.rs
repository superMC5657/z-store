// 防止在 Windows Release 模式下弹出额外的控制台窗口，切勿删除！！
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    zstore_lib::z_log::install_panic_hook();
    zstore_lib::run();
}
