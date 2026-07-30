//! Terminal latency benchmark harness for Pragma.
//!
//! The desktop terminal's perceived latency is spread across nine hops, from a
//! DOM keydown to a GPU paint. No single number describes it, so the harness is
//! split into tiers that each own the hops they can measure *honestly*:
//!
//! - **T1 (this crate)** — hops 4-7: `pragma-client` → local socket →
//!   `pragma-server` → PTY, and back. It drives a real `pragma-server` binary
//!   over a real socket, so it measures the transport the desktop app actually
//!   uses rather than a reimplementation of it.
//! - **T2 (`src/parser.ts`)** — hop 8: xterm's parser, via `@xterm/headless`.
//! - **T3 (`apps/pragma/src/lib/*.bench.ts`)** — the frontend policy layer:
//!   the WebGL renderer LRU, the mouse-wheel gate, and tab retention.
//!
//! Hops 1-3 (DOM → Tauri IPC) and hop 9 (GPU paint) are deliberately not
//! benchmarked: a headless webview cannot paint xterm, so any number produced
//! for them would describe the harness rather than the app.
//!
//! Every tier emits the same [`report::Report`] shape, and `src/index.ts` merges
//! them into one audit.

pub mod corpus;
pub mod harness;
pub mod report;
pub mod scenarios;
pub mod stats;
