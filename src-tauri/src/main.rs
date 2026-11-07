// main.rs - desktop entry point. The app lives in lib.rs so the mobile shells can share it.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

fn main() {
    briefcast_lib::run();
}
