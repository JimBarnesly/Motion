#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if !motion_desktop_lib::run_native_helper_if_requested() {
        motion_desktop_lib::run();
    }
}
