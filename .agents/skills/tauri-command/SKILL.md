---
name: tauri-command
description: Use when adding or modifying a Tauri command / IPC call between the React frontend and the Rust backend in Pragma (#[tauri::command], invoke, src/lib/tauri.ts, generate_handler).
---

# Adding a Tauri command (frontend ⇄ backend)

Keep the IPC surface **typed and centralized**. Every command exists in three places
with the same name: the Rust handler, the TS wrapper, and tests.

## Steps

1. **Rust** — `apps/pragma/src-tauri/src/lib.rs`:

   ```rust
   #[tauri::command]
   fn my_command(arg: String) -> MyResult { /* ... */ }
   ```

   Register it: `.invoke_handler(tauri::generate_handler![app_info, my_command])`.
   Prefer argument/return types from `pragma_constants` so the contract is shared.

2. **TS wrapper** — `apps/pragma/src/lib/tauri.ts` (the ONLY place `invoke` is used):

   ```ts
   export function myCommand(arg: string): Promise<MyResult> {
     return invoke<MyResult>("my_command", { arg });
   }
   ```

   Note: Tauri converts the Rust `snake_case` command name; the JS arg object keys map
   to the Rust parameter names.

3. **Components** import `myCommand` from `@/lib/tauri` — never call `invoke()` directly.

4. **Tests:**
   - TS: mock `@tauri-apps/api/core`'s `invoke` (see `src/App.test.tsx`) and assert the
     call + rendered result.
   - Rust: a `#[cfg(test)]` test for the command's pure logic.

## Rules

- **Never block the main thread.** A plain `#[tauri::command]` runs its body inline in
  the webview IPC handler on the macOS main thread — while it runs, painting and every
  queued IPC call (including terminal keystrokes) freeze. Any command that does a daemon
  RPC (`host_rpc`), spawns a subprocess, hits the network, or reads/writes files must be
  `async fn` (offload blocking work with `spawn_blocking`, see `run_pty_task`) or at
  minimum `#[tauri::command(async)]`, which runs the sync body on the tokio pool. Only
  trivially fast work (in-memory state, a single SQLite row, native window calls that
  must run on the main thread anyway) may stay a plain sync command.
- One responsibility per command; share payload types via `@pragma/constants`.
- Return `Result` on the Rust side for fallible work; surface errors as typed values to
  the frontend and narrow with `instanceof Error`.
- Run `bun run --filter pragma tauri:dev` to exercise it end-to-end.
