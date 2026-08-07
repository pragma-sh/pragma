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
  - **Device history:** `clientFor()` also sends installation id, platform, display
    label, and app version headers. Installation id has its own SecureStore key so
    unpairing does not create a new device in desktop gateway history.
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
  `lib/data/workspace-map.ts`. The worktree agent list is **tab-driven**: every
  open terminal tab tagged with an agent (`Tab.agentId`, set generically for
  any catalog agent at launch — first- or third-party) or carrying a live
  status report (a manually started agent) appears, active or inactive, and
  disappears when the tab closes; reports only overlay the status dot.
  `resolveInboxItem` publishes the decision/answer
  through the client. Opening a completed chat marks its done status seen locally and
  on the host. Long-press agent-row action sheets rename through `client.sessions.rename()`
  or kill the matching PTY, then hide cleared rows locally.
- **Launch** (`components/LaunchSheet.tsx`, from the worktree header "+"): agent
  picker fed by the host catalog (`lib/use-catalog.ts`), `client.agents.launch()`
  with the payload shaped by the pure `lib/launch-form.ts`. Existing-worktree
  launches run headlessly through persistent server when desktop is closed, including
  creating a new git worktree from a mirrored parent.
- **Home-screen widgets** (`lib/widgets/`, iOS only): `expo-widgets` renders four
  WidgetKit widgets from `@expo/ui/swift-ui` components. See _Widgets_ below.
- **Scratchpads** (`app/scratchpad/[scratchpadId].tsx`): a worktree screen lists its
  managed scratchpads (`lib/use-scratchpads.ts` → `client.scratchpads.getScratchpads`)
  in the same row style as its agents, subtitled with the attached agent
  (`lib/scratchpad-agent.ts`). Opening one shows `ScratchpadLoading` while the host
  serves the file and again (as an overlay) until the web view's MDX is ready, then
  renders the document **read-only** in a `react-native-webview` fed by
  `@pragma/scratchpad-viewer`, so interactive `@pragma/scratchpad` components behave as
  they do on the desktop. Comment mode (header toggle) turns the document into a
  picker: tap a block to comment, or press and hold to preview where the comment lands
  and drag before releasing. Comments are written to the desktop's own sibling
  `<file>.mdx.comments.json` (`lib/use-scratchpad-comments.ts`), and the footer submits
  every open one to the attached agent as a single message — the same handoff the
  desktop's "Resolve comments" sends — then marks them resolved. Attachment is a drawer
  (`components/scratchpad/AttachAgentDrawer.tsx`) that rewrites the file's frontmatter;
  it opens only when send (or an interactive block) needs an agent and none is attached.
  The reverse link is a pill: `components/chat/ScratchpadPill.tsx` finds the scratchpads
  whose frontmatter names this chat's tab (`scratchpadsForAgentTab`) and shows the first
  (`+N` when there are more) directly above the composer, tapping through to the
  scratchpad screen. It sits **inside** the chat's `KeyboardAvoidingView`, which is what
  keeps the keyboard from covering it — do not hoist it above that subtree.
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
- **Home-screen widgets** via `expo-widgets` + `@expo/ui/swift-ui` — WidgetKit widgets
  written as React components, with the extension target generated by the config plugin
  during prebuild. iOS only (`enableAndroid` is off).
- **Native modules needing a dev-client rebuild** (`expo run:ios`): `expo-camera` (QR
  pairing), `expo-secure-store` (persisted connection config), `react-native-svg`
  (agent icons), `expo-widgets` (the widget extension target), `react-native-webview`
  (the scratchpad viewer). Pure-JS additions (`@pragma/sdk`,
  `@pragma/scratchpad-viewer`) do not.
- **Tests**: pure logic (transcript store, pairing, workspace mapping, launch form) is
  Vitest-covered under `lib/**/*.test.ts` (`bun run --filter pragma-mobile test`, node
  env, RN-free). Screens/streaming are verified manually in the dev client.

## Layout

```
app/
  _layout.tsx                     # providers: GestureHandlerRoot, SafeArea, Connection, Theme, Data, PortalHost
  pair.tsx                        # QR + manual pairing (modal)
  (tabs)/_layout.tsx              # NativeTabs: Projects + Inbox (with badge)
  (tabs)/(projects)/              # Stack: drill-down
    index.tsx                     #   all projects
    project/[projectId].tsx       #   project → root worktree(s)
    worktree/[worktreeId].tsx     #   nested worktrees + agent tabs (header + launches agent)
  chat/[tabId].tsx                # full-screen live agent chat (outside tabs)
  scratchpad/[scratchpadId].tsx   # read-only scratchpad web view + touch comments
  (tabs)/inbox/                   # Stack: swipeable event cards
components/
  ui/*                            # React Native Reusables primitives
  scratchpad/                     # ScratchpadWebView, ScratchpadLoading, CommentComposerSheet, AttachAgentDrawer
  chat/                           # ChatScreen parts: MessageList, MessageRow, Composer, AttentionDock, ScratchpadPill
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
  use-scratchpads.ts             # a worktree's managed scratchpads, re-read on demand
  use-scratchpad-comments.ts     # the desktop's sibling comment file, read + serialized writes
  scratchpad-agent.ts            # pure: attached-tab resolution, tab → scratchpads, row label (Vitest)
  data/                          # data-context (live subscription vs. fixtures) + workspace-map (pure, Vitest)
  types.ts                       # re-exports @pragma/constants domain types + view shapes
  worktree-tree.ts               # nesting logic, kept in lockstep with desktop
  agent-status.ts                # status rollup priority
  haptics.ts                     # haptic intent wrappers
  widgets/                       # widget-data (pure, Vitest) + widget layouts + app→widget sync
  push.ts                        # Expo push: permission, token registration, unregister + retry
  push-route.ts                  # pure: notification data → chat route (Vitest)
  pending-revocation.ts          # pure: queue of unacknowledged unregisters (Vitest)
  registration-gate.ts           # pure: orders registration before unregister (Vitest)
  use-push-notifications.ts      # registers on pair, opens the tab a tapped alert names
  theme-context.tsx              # fetches the host theme, applies it as NativeWind vars
  theme-vars.ts                  # pure: desktop theme tokens → NativeWind vars (Vitest)
  theme.ts                       # resolved colors for native props that take a string
  viewed-project.ts              # pure: focused screen's project theme root store (Vitest)
  use-viewed-project.ts          # focus hook reporting a screen's project root to that store
```

## Widgets

Four iOS home-screen widgets, declared in `app.json` under the `expo-widgets` plugin and
implemented in `lib/widgets/`:

| Name (config + `createWidget`) | Families                                                 | Content                                    |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------------ |
| `PragmaAttention`              | `systemSmall` + the three Lock Screen accessory families | Agents waiting on you, as one number       |
| `PragmaAgents`                 | `systemMedium`                                           | Three columns: working / attention / done  |
| `PragmaInbox`                  | `systemMedium`, `systemLarge`                            | The oldest pending approvals and questions |
| `PragmaProjects`               | `systemMedium`, `systemLarge`                            | Projects with their live worktrees nested  |

- **A widget layout cannot close over anything.** `babel-preset-expo`'s widgets plugin
  replaces every function carrying the `'widget'` directive with a **string** of its own
  source, which the extension evaluates against a runtime whose only globals are the
  `@expo/ui/swift-ui` exports and modifiers. A reference to a module constant, an imported
  helper, or a shared color token is `undefined` at render time. Keep helpers and literals
  inside the function body, and let everything data-shaped arrive through props.
- **A mapped list must be the sole child of its container.** The extension keeps only
  children that are element nodes (`compactMap { $0 as? [String: Any] }` in
  `expo-widgets`' `DynamicView.swift`) and never flattens nested arrays, unlike React. A
  `{items.map(...)}` sitting next to sibling children arrives as one array child and is
  dropped whole — the widget renders its header and empty-state only, with no error
  anywhere. Wrap the map in its own `VStack`/`HStack`. The same rule kills any child that
  is a bare string or number.
- **Derivation is pure and tested; layouts are dumb.** `lib/widgets/widget-data.ts` turns
  the same view models the screens use into a `WidgetSnapshot` (counts, capped inbox rows,
  project rollups, pre-built deep links) and is Vitest-covered; the layouts only render it.
- **The widget cannot reach the host.** The extension renders the last snapshot the app
  pushed, so `lib/widgets/use-widget-sync.ts` (mounted in `app/_layout.tsx`) re-pushes on
  content change, coalesced to at most one push per 15s because WidgetKit budgets reloads.
  A widget therefore shows the state as of the last time the app ran; `updatedAt` rides
  along in every snapshot for layouts that want to surface that. It pushes nothing while
  the connection status is `loading` — that status is the restore probe still running,
  and collapsing it to `paired: false` would blank a paired user's widgets on every
  launch until the throttled correction landed up to 15s later.
- **Colors are SwiftUI named colors, not the app's tokens.** A widget has no NativeWind
  theme, and `red`/`orange`/`green`/`gray` already adapt to light, dark, and tinted
  rendering modes. `statusColor()` maps agent status onto them in the same
  attention/running/done priority as `AgentStatusDot`.
- **Every system-family layout sets its own `containerBackground`.** `expo-widgets` never
  applies one, and a widget that declares no container background gets iOS's legacy
  backdrop — which stays dark on a light-mode home screen, so the widget looks stuck in
  dark mode. Paint it from `environment.colorScheme` (`#FFFFFF` / `#1C1C1E`). Do **not**
  add it to the `accessory*` families: the Lock Screen supplies its own backdrop
  (`AccessoryWidgetBackground`).
- **`supportedFamilies` is native, so it needs a rebuild.** Layout code ships as a string
  the app pushes at runtime and updates without a rebuild, but the family list lives in the
  generated `ios/ExpoWidgetsTarget/<Name>.swift`. After editing `app.json`, run
  `bun run prebuild` and reinstall the dev client, or the removed size stays in the gallery.
- **The project widget mirrors the app's worktree tree.** `PragmaProjects` lists each
  project with its worktrees nested beneath it, in `buildWorktreeTree` order (main first),
  indented by depth — the same structure the Projects → project screens drill through. A
  worktree earns a row only when it is _live_: an agent that is `running`/`attention`, or
  `done` and not yet viewed. `cleared` (viewed, or never reporting) is not news, so it is
  left out, and a project with no live worktree drops entirely. An idle ancestor of a live
  worktree is kept so the child is not orphaned; its own agent count is then 0 and its dot
  is the subtree rollup. `widget-data.ts` caps what it carries
  (`WIDGET_PROJECT_LIMIT` projects, `WIDGET_WORKTREE_LIMIT` worktree rows in total) and the
  layout trims again to its family's row budget, clipping a group's worktrees rather than
  leaving a project header with nothing under it.
- **Deep links are built in the app, not the widget.** `expo-linking`'s `createURL` needs
  the app runtime, so `use-widget-sync.ts` resolves `/inbox`, `/project/<id>`, and
  `/worktree/<id>` and passes the strings down. Every widget targets the inbox through
  `widgetURL`; the inbox, project, and worktree rows override that per row with `Link`.

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
- **The theme mirrors the desktop's, it is not redefined here.** `ThemeProvider`
  (`lib/theme-context.tsx`) fetches `client.theme.get()` and applies the result as
  NativeWind variables on a root view, so every `bg-background`-style class follows the
  user's `.pragma/theme.json` with no per-screen work. Three things to know:
  - **`global.css` stays the default.** Only overrides come over the wire; an unpaired
    phone, a host with no theme file, or a failed fetch keeps the shipped palette. The
    fetch failure is swallowed on purpose — there is nothing for the user to act on.
  - **Conversion is `lib/theme-vars.ts`, and it is not just a copy.** Desktop themes are
    `oklch(...)`; `tailwind.config.js` wraps every token as `hsl(var(--token))`, so each
    value becomes a bare `H S% L%` triple (via culori) clamped to sRGB and snapped to
    8-bit — without the snap, round-trip noise turns white into a saturated hue. Tokens
    outside `MOBILE_THEME_TOKENS` and unparseable values are dropped, never thrown.
  - **It is polled, on purpose.** A desktop theme edit rewrites a file the gateway only
    reads on request; there is no `themeChanged` subscription to ride, so a one-shot
    fetch at pair time strands the phone on a stale palette. `useHostTheme` re-reads
    every 10s while the app is in front and again on return from the background, and
    compares `themeKey` before setting state so an unchanged poll re-renders nothing. A
    failed poll keeps the palette in effect rather than flashing back to defaults.
    Overlapping polls are sequence-guarded: only the latest request may apply, so a
    fetch that started before a theme change cannot land after one that read it.
  - **The project layer follows the focused screen.** This app has no selected project,
    so the project, worktree, and chat screens report their project's main-worktree
    path on focus (the projects list reports `null`) through the pure
    `lib/viewed-project.ts` store (`useViewedProjectRoot` in
    `lib/use-viewed-project.ts`); `ThemeProvider` passes it as `root` to
    `client.theme.get({ root })`, layering that project's `.pragma/theme.json` over the
    global one. The root is the **main worktree's path** (`useProjectRootPath`), the
    same anchor the desktop uses for project-scoped `.pragma` files.
  - **Native props cannot read classes.** Header tints, `placeholderTextColor`, and menus
    go through `useThemeColors()` (`lib/theme.ts`), which resolves the same overrides
    eagerly so both paths agree.
- **Push notifications come from the host, not from here.** The gateway watches its own
  agent stream and sends through Expo (`crates/pragma-gateway/src/push/`), so alerts
  arrive with the app closed. This app only registers its Expo token
  (`POST /v1/push/tokens`, refreshed on every launch while paired), unregisters on
  unpair, and routes a tap to `/chat/[tabId]` with the ids the push carried. Token
  minting needs an EAS project id from the runtime manifest or `extra.eas.projectId`
  in `app.json`; without it `registerForPush` returns `unsupported` and the app runs
  unchanged.
- **An unregister the host never acknowledged is queued, never dropped.** Unpair has to
  work with the desktop unreachable, but discarding the failed `DELETE /v1/push/tokens`
  would leave the gateway pushing agent-alert text to a phone that can no longer ask it
  to stop. `push.ts` persists that host's credentials (`pragma.push-revocation.v1`,
  SecureStore) and `ConnectionProvider` retries them at startup before pairing;
  `pending-revocation.ts` holds the pure queue rules (one entry per host, capped, and
  expired after 30 days so unpaired credentials are not kept forever). Pairing a host
  again forgets its queued revocation, and a 401 retires one: a rejected token can
  never revoke anything.
- **A registration in flight is ordered before the unregister, never racing it.** The
  `POST /v1/push/tokens` a launch fires is idempotent but not harmless: landing after an
  unpair's `DELETE`, it re-arms delivery to a phone that is no longer paired.
  `registration-gate.ts` (pure, Vitest) holds the single in-flight registration;
  `unregisterFromPush` settles it first, cancelling it if the host takes longer than
  `REGISTRATION_SETTLE_MS`. Callers pass an `AbortSignal` (the hook aborts on cleanup)
  and a cancelled registration reports `reason: "cancelled"`, which is not warned about.
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
