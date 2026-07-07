# Pragma Mobile — Agent & Contributor Guide

Expo (SDK 57) native client that mirrors the desktop sidebar's worktree
navigation and surfaces agent approvals/questions as an actionable inbox.

> **Front-end only right now.** No app server is wired in. All data comes from
> `lib/data/fixtures.ts` behind the `lib/data/data-context.tsx` provider. Wiring
> the real server later means replacing the provider's seed state and
> `resolveInboxItem` body — screens and components do not change.

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
  Android popup that supports nested submenus. `AgentModelSelector` uses it for the
  agent → model → reasoning drill-down (leaf ids encode the selection). It's a native
  module: adding/removing it requires a **dev-client rebuild** (`expo run:ios`).

## Layout

```
app/
  _layout.tsx                     # providers: GestureHandlerRoot, SafeArea, Theme, Data, PortalHost
  (tabs)/_layout.tsx              # NativeTabs: Projects + Inbox (with badge)
  (tabs)/(projects)/              # Stack: drill-down
    index.tsx                     #   all projects (settings-style rows)
    project/[projectId].tsx       #   project → root worktree(s)
    worktree/[worktreeId].tsx     #   nested worktrees + agent tabs (recurses)
    chat/[tabId].tsx              #   chat placeholder
  (tabs)/inbox/                   # Stack: swipeable event cards
components/
  ui/*                            # React Native Reusables primitives
  NavRow / WorktreeNavRow         # iOS Settings-style rows
  AgentStatusDot                  # running/attention/done rollup dot
  InboxCard                       # swipe-right = approve/submit, swipe-left = deny
  NewWorktreeButton               # header-right "+" (in-project screens) → New Worktree sheet
  AgentModelSelector              # native nested menu: agent → model → reasoning
  GlassSurface / IconSymbol
lib/
  data/                           # fixtures + swappable provider/hooks
  types.ts                        # re-exports @pragma/constants domain types
  worktree-tree.ts                # nesting logic, kept in lockstep with desktop
  agent-status.ts                 # status rollup priority
  haptics.ts                      # haptic intent wrappers
```

## Rules

- **One source of truth for the domain.** `Project`, `Worktree`, `AgentStatus`, and
  `AgentAttentionKind` are imported (type-only) from `@pragma/constants`. Do not redefine
  them here. View-only shapes (`AgentTab`, `InboxItem`) live in `lib/types.ts`.
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
bun run --filter pragma-mobile prebuild      # generate native ios/ android projects
```
