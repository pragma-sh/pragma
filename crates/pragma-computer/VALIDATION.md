# Computer-use implementation and validation

The worktree plan is `.pragma/scratchpads/computer-use-plan-macos-windows-daafc30e.mdx`.
Existing background-input/cursor changes were retained while completing the host, SDK,
Windows, task, capture, packaging and documentation paths.

| Phase                              | Implementation                                                                                                                         | Verification boundary                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts and macOS direct actions | Existing pipeline extended with task contracts, observed URLs and cancellation generations                                             | Pure rules, fake backend and host RPC tests                                                                                                                                         |
| Local SDK access                   | Separate owner-only credential gates RPC and activity; terminal attribution survives; user authority is discarded                      | Gateway scope, SDK transport, screenshot and error tests                                                                                                                            |
| Windows parity                     | Cached MTA UIA, revalidation, Invoke/Value, Unicode input, guarded pointer operations, elevation checks, PMv2 manifest, bundled helper | Source checked against MSVC bindings; native x64/ARM64 CI and live OS matrix still required                                                                                         |
| Jev tasks                          | Correlated long-lived sidecar, independent bounded choices, input handoff, recipes, persistence, budgets, ownership and cancellation   | Fake-backend task tests, synthetic offline answer replay; live Jev accuracy not measured                                                                                            |
| PiP/cursor                         | Existing in-app panel retained; cancellable JPEG channel, output scaling and explicit SCK exclusions                                   | Desktop reducer/geometry and channel lifecycle tests; Settings inspected with Jev; both grants confirmed after refreshing the stale helper; live frame/input matrix remains pending |
| Docs                               | User/CLI/SDK guides, metadata, contributor guides and skills updated                                                                   | Website typecheck and production build passed                                                                                                                                       |
| Conditional 6b                     | Five-fps JPEG delivery is implemented; native continuous SCStream/WGC video remains gated                                              | Requires capture/CPU/RSS measurements before choosing the continuous backend                                                                                                        |

## Checks completed in this worktree

- Workspace typecheck: 47 tasks plus the launch-video TypeScript project passed.
- SDK: 64 tests; AI helpers: 175; System 1: 13; desktop computer-use: 15.
- Rust: 33 host computer-use tests, four task-rule tests, 12 helper tests,
  67 gateway tests and two desktop preview lifecycle tests passed.
- Helper/server/gateway clippy, repository formatting, rustfmt and diff whitespace checks passed.
  Repository lint passed with existing unrelated warnings.
- Website production build passed. Three synthetic offline decision replays passed.
- Windows helper source passed an MSVC-target clippy check using real Windows bindings
  and a minimal core shim. This excludes the unrelated V8/SQLite dependency graph;
  it does not replace the full Windows CI build or native testing.
- Jev inspected the final Settings page, cursor toggle and emergency shortcut.
  After the user enabled both grants, a fresh helper reported both granted while the
  persistent helper retained a cached Accessibility denial. Restarting only that helper
  made the dev CLI report both granted. Permission rechecks now refresh an idle helper
  after a missing grant, and Settings rechecks on focus. No policies were changed.
- Task-output regression checks: five CLI tests passed, and the rebuilt CLI read the
  user's existing `lowConfidence` task with an explicit reason and recovery command.
  Fake-backend tests cover missing URL/text handoffs and resuming navigation with a
  supplied URL, without model calls. Input handoffs are displayed as waiting for input.

## Native release checks still required

The macOS overlay focus regression now runs on the native desktop with
`PRAGMA_NATIVE_FOCUS_TEST=1 cargo test -p pragma --test macos_background_webview`.
It passed for first and subsequent hidden overlay creation and showing, with
another app remaining foreground. The desktop native focus path also restored
that app before the overlay checks. This covers the vendored webview-library
fix, not the remaining multi-display/fullscreen/input matrix below. A control run
against unmodified wry reproduced focus theft during hidden overlay creation;
the test passes with the patch and unmodified tao.

- macOS 14, 15, 26: Accessibility and Screen Recording grants for the helper identity;
  signed and notarized nested helper survives an app update; screenshot colors/scaling.
- Retina plus a second display, negative origins, fullscreen Spaces, minimized/covered
  windows, Secure Input, and physical takeover in the target app only.
- Windows 10 22H2 and Windows 11 x64/ARM64: Calculator/Store app launch, Notepad/Edge UIA,
  mixed DPI, refused activation, elevated Task Manager, Unicode/IME and pointer modifiers.
- Emergency stop during 2,000-character input within 100 ms; preview cancellation,
  worktree switching, fullscreen exclusions and repeated session creation without leaks.
- Ten live tasks and recorded-run replay with the configured Jev endpoint. Synthetic
  fixtures prove request/answer handling, not model accuracy.
- Preview CPU/RSS against the plan's budgets before enabling continuous native capture.

Windows takeover counts only physical (non-injected) key presses, clicks, drags, and
scrolls, read through low-level input hooks. Images/box answers are opt-in client capabilities; autonomous vision fallback
is disabled. These limits are also stated in the public guide.
