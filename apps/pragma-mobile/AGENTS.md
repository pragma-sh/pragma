# Pragma Mobile — Agent & Contributor Guide

Expo (SDK 57) native client that mirrors the desktop sidebar's worktree
navigation, surfaces agent approvals/questions as an actionable inbox, and — once
paired with a desktop — streams live agent chat and launches new sessions.

> **Paired vs. unpaired.** The app talks to a host desktop through `@pragma/sdk`
> (the local HTTP gateway over the remote-access tunnel). It renders workspace data
> and agent chat only after verifying a saved or newly paired connection. Without a
> verified connection, `app/pair.tsx` replaces the app until pairing succeeds. The seam
> is `lib/connection-context.tsx` (owns the single `PragmaClient`) and
> `lib/data/data-context.tsx` (live subscription).

## Remote access (the paired path)

- **One client, one owner.** `lib/connection-context.tsx` owns the app-wide
  `PragmaClient`. Config is persisted in the device keychain
  (`expo-secure-store`) and, for development only, falls back to
  `EXPO_PUBLIC_PRAGMA_GATEWAY_URL` / `EXPO_PUBLIC_PRAGMA_GATEWAY_TOKEN`. A failed
  startup probe or mid-session **401** clears state and shows the full pairing screen
  (the host may have regenerated its token). Everything gateway-facing goes through `@pragma/sdk`; never
  hand-build gateway routes or a second client.
- **Streaming fetch.** The client is wired to `expo/fetch` (a real
  `ReadableStream` body) so the SDK's NDJSON reader works on device — RN's global
  `fetch` does not stream reliably. If NDJSON streaming misbehaves, this is the
  first thing to check.
- **Pairing** (`app/pair.tsx`): QR scan (`expo-camera`) or manual URL/token.
  Pure shape + protocol-version validation lives in `lib/pairing.ts`
  (`EXPECTED_PROTOCOL_VERSION` = `constants.daemon.protocolVersion`); the live
  reachability/token probe is `probeConnection()` (an authed `agents.catalog()`
  call). QR carries the protocol version; manual entry can't, so it's checked by
  the probe only.
  - **ngrok interstitial gotcha:** every gateway request goes through
    `clientFor()` in `lib/connection-context.tsx`, which sets the
    `ngrok-skip-browser-warning` header. ngrok's free tier serves an HTML
    browser-warning page (200, `text/html`) to browser-like User-Agents — which
    RN's `fetch` is — instead of proxying; without the header the SDK gets HTML,
    JSON parsing fails, and pairing dies with a misleading "couldn't reach the
    desktop". Other hosts ignore the unknown header.
- **Chat** (`chat/[tabId].tsx`): `lib/use-agent-connection.ts` opens a duplex
  `client.agents.connect()` on screen focus and closes on blur, folding events
  into the **pure** `lib/transcript-store.ts` (upsert-by-id, ts ordering,
  attention raise/clear; model reasoning rows are omitted). Reconnects with capped backoff; buzzes on attention +
  approve/deny. Launch-time `agent`/`worktreeId` params let a freshly launched
  session attach before the workspace snapshot catches up. Catalog-qualified
  launch ids are reduced to the plugin's runtime agent id for stream routing.
- **Icons** (`components/AgentIcon.tsx`): plugin agent icons are fetched by
  content hash through the authed `AssetsClient` (SVG → `SvgXml`, raster →
  data-URI `Image`), cached by hash. **Never** render an agent icon as a bare
  `Image` URL — the bearer token must ride the request header.
- **Live data** (`lib/data/data-context.tsx`): when paired it subscribes to
  `client.workspace.subscribe()` (projects/worktrees/tabs) + the `agentStatus`
  protocol event, mapping rows to view models via the pure
  `lib/data/workspace-map.ts`. `resolveInboxItem` publishes the decision/answer
  through the client. Opening a completed chat marks its done status seen locally and
  on the host. Long-press agent-row action sheets rename through `client.sessions.rename()`
  or kill the matching PTY, then hide cleared rows locally.
- **Launch** (`components/LaunchSheet.tsx`, from the worktree header "+"): agent
  picker fed by the host catalog (`lib/use-catalog.ts`), `client.agents.launch()`
  with the payload shaped by the pure `lib/launch-form.ts`. Existing-worktree
  launches run headlessly through persistent server when desktop is closed, including
  creating a new git worktree from a mirrored parent.
- **New worktree** (`components/NewWorktreeSheet.tsx`, from project/chat header "+"):
  agent picker uses same host catalog as launch. Submission uses the same headless-capable
  `client.agents.launch()` control route as existing-worktree launches.

## Stack

- **Expo SDK 57** + **expo-router** (file-based routing, typed routes, React Compiler).
- **New Architecture** enabled; requires a **custom dev build** (not Expo Go) because
  of native modules (liquid glass, native tabs, gesture-handler/reanimated 4).
- **NativeWind v4** (Tailwind) for styling; tokens live in `global.css` + `tailwind.config.js`.
- **React Native Reusables** component conventions — primitives in `components/ui/*`
  (`@rn-primitives/*` under the hood). Add more with
  `npx @react-native-reusables/cli@latest add <name>`.
- **Native platform look**: `expo-router/unstable-native-tabs` (system tab bar, liquid
  glass on iOS 26), `expo-glass-effect` via `components/GlassSurface.tsx` (solid-card
  fallback off Apple), `expo-symbols` SF Symbols via `components/IconSymbol.tsx`.
- **Haptics** everywhere via `lib/haptics.ts` (intent-named wrappers over `expo-haptics`).
- **Native menus** via `@react-native-menu/menu` (`MenuView`) — a native iOS pull-down /
  Android popup. `AgentModelSelector` uses agent submenus with model leaves, then shows
  a separate effort menu for reasoning-capable models. Do not nest effort under model:
  Android does not support that depth and it conflicts with modal stacking on iOS. It's
  a native module: adding/removing it requires a **dev-client rebuild** (`expo run:ios`).
- **Gateway SDK** via `@pragma/sdk` (`PragmaClient`) — the only way this app talks to a
  host. Pure JS (no dev-client rebuild).
- **Agent markdown** via `react-native-marked`'s `useMarkdown` hook. Use the hook inside
  chat rows rather than its `FlatList` component so streamed message replacements reparse
  incrementally without nesting a virtualized list inside the transcript `FlatList`.
- **Native modules needing a dev-client rebuild** (`expo run:ios`): `expo-camera` (QR
  pairing), `expo-secure-store` (persisted connection config), `react-native-svg`
  (agent icons). Pure-JS additions (`@pragma/sdk`) do not.
- **Tests**: pure logic (transcript store, pairing, workspace mapping, launch form) is
  Vitest-covered under `lib/**/*.test.ts` (`bun run --filter pragma-mobile test`, node
  env, RN-free). Screens/streaming are verified manually in the dev client.

## Layout

```
app/
  _layout.tsx                     # providers: GestureHandlerRoot, SafeArea, Connection, Data, PortalHost
  pair.tsx                        # QR + manual pairing (modal)
  (tabs)/_layout.tsx              # NativeTabs: Projects + Inbox (with badge)
  (tabs)/(projects)/              # Stack: drill-down
    index.tsx                     #   all projects
    project/[projectId].tsx       #   project → root worktree(s)
    worktree/[worktreeId].tsx     #   nested worktrees + agent tabs (header + launches agent)
  chat/[tabId].tsx                # full-screen live agent chat (outside tabs)
  (tabs)/inbox/                   # Stack: swipeable event cards
components/
  ui/*                            # React Native Reusables primitives
  chat/                           # ChatScreen parts: MessageList, MessageRow, Composer, AttentionDock
  AgentIcon                       # plugin agent icon fetched by hash (SVG/raster, cached)
  LaunchSheet                     # launch a new agent session (catalog-fed picker)
  LaunchAgentButton               # worktree header-right "+" → Launch sheet
  NavRow / WorktreeNavRow         # iOS Settings-style rows
  AgentStatusDot                  # running/attention/done rollup dot
  InboxCard                       # swipe-right = approve/submit, swipe-left = deny
  NewWorktreeButton               # project/chat header-right "+" → New Worktree sheet
  AgentModelSelector              # native nested menu: agent → model → reasoning
  GlassSurface / IconSymbol
lib/
  connection-context.tsx         # app-wide PragmaClient owner + pairing state + probe
  use-agent-connection.ts        # chat: focus-scoped duplex connection → transcript store
  transcript-store.ts            # pure: event fold → rows + attention (Vitest)
  pairing.ts                     # pure: QR/manual validation + protocol check (Vitest)
  launch-form.ts                 # pure: launch payload shaping (Vitest)
  use-catalog.ts                 # cached host agent catalog
  data/                          # data-context (live subscription vs. fixtures) + workspace-map (pure, Vitest)
  types.ts                       # re-exports @pragma/constants domain types + view shapes
  worktree-tree.ts               # nesting logic, kept in lockstep with desktop
  agent-status.ts                # status rollup priority
  haptics.ts                     # haptic intent wrappers
```

## Rules

- **One source of truth for the domain.** `Project`, `Worktree`, `AgentStatus`, and
  `AgentAttentionKind` are imported (type-only) from `@pragma/constants`; wire event
  types (`AgentStreamEvent`, `AgentMessage`, `AgentReportPayload`, …) come from
  `@pragma/sdk`. Do not redefine them here. View-only shapes (`AgentTab`, `InboxItem`,
  `AttentionRequest`, `TranscriptRow`) live in `lib/types.ts`.
- **Keep logic pure and tested.** Any non-trivial derivation (transcript folding,
  pairing validation, workspace→view mapping, launch payload) goes in an RN-free `lib/*`
  module with a co-located `*.test.ts`. Screen components stay thin.
- **Never call `expo-haptics` / `expo-glass-effect` / `expo-symbols` directly** from a
  screen — go through `lib/haptics.ts`, `GlassSurface`, and `IconSymbol` so fallbacks
  and platform checks stay in one place.
- **Status rollup matches the desktop.** `agent-status.ts` priority is
  attention > running > done; `cleared`/none render no dot.
- **Monorepo Metro.** `metro.config.js` watches the repo root and resolves the hoisted
  `node_modules`; keep it if you add workspace deps.
- **oxlint RN overrides.** The root `.oxlintrc.json` has an `apps/pragma-mobile/**`
  override turning off three web-oriented rules that misfire on React Native:
  `react/style-prop-object` (expo-status-bar `style="auto"` is a string),
  `import/namespace` (oxlint can't follow `@rn-primitives` `export *` re-exports), and
  `jsx-a11y/no-autofocus` (DOM rule; RN `TextInput` autoFocus differs). Fix real lint
  errors here — don't widen these off.

## Monorepo install (important)

Expo/Metro resolve Babel presets/plugins with plain Node resolution, which breaks under
Bun's default **isolated** linker (`@babel/preset-*` become unresolvable). The repo root
`bunfig.toml` therefore pins `[install] linker = "hoisted"` — keep it. Without it,
`expo export` / `expo start` fail with `Cannot find module 'babel-preset-expo'` and
friends.

## Commands

```bash
bun install                                  # from repo root (hoisted linker)
bun run --filter pragma-mobile start         # Metro dev server (needs a dev build to run)
bun run --filter pragma-mobile ios           # build + run iOS dev client
bun run --filter pragma-mobile android       # build + run Android dev client
bun run --filter pragma-mobile typecheck     # tsc --noEmit
bun run --filter pragma-mobile test          # Vitest (pure lib/**/*.test.ts, node env)
bun run --filter pragma-mobile prebuild      # generate native ios/ android projects
```

Typecheck needs `@pragma/sdk`'s built `dist` (`bun run --filter @pragma/sdk build`);
`turbo typecheck`/`test` build it via `^build`.
