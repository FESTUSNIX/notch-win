// Release builds link against the *windows* subsystem rather than the console
// one, so launching the app does not also open a console window behind it.
//
// Debug builds keep the console on purpose: it is where every `println!` in
// this crate goes — the provider readings, the activity state, the rate-limit
// back-off. Losing it would mean losing the only log the app has.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    codenotch_lib::run()
}
