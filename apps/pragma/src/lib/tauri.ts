import type { AppInfo } from "@pragma/constants";
import { invoke } from "@tauri-apps/api/core";

/**
 * Typed bridge to the Rust backend commands.
 *
 * Keep every `invoke` call behind a named function here so the rest of the app
 * never touches raw command strings — one place to keep the TS and Rust sides
 * in sync. See `src-tauri/src/lib.rs` for the matching `#[tauri::command]`s.
 */
export function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}
