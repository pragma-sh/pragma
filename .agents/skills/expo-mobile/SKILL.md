---
name: expo-mobile
description: Use when working on apps/pragma-mobile — the Expo (SDK 57) native client. Covers expo-router file routing, native tabs, NativeWind + React Native Reusables, expo-glass-effect liquid glass, SF Symbols, haptics, and the monorepo Metro setup.
---

# Pragma Mobile (Expo) development

`apps/pragma-mobile` is an Expo SDK 57 app that mirrors the desktop sidebar's
worktree navigation and turns agent approvals/questions into a swipeable inbox.
**Front-end only** today — data comes from `lib/data/fixtures.ts` behind
`lib/data/data-context.tsx`. See `apps/pragma-mobile/AGENTS.md` for the full map.

## Non-negotiables

- **Dev build, not Expo Go.** Native modules (liquid glass, native tabs,
  gesture-handler + reanimated 4) require `expo run:ios` / `expo run:android` or an
  EAS dev client. Expo Go will crash on these.
- **Domain types come from `@pragma/constants`** (type-only import). Do not redefine
  `Project` / `Worktree` / `AgentStatus` / `AgentAttentionKind`. Keep
  `lib/worktree-tree.ts` and `lib/agent-status.ts` in lockstep with the desktop's
  `apps/pragma/src/lib/worktree-tree.ts` + agent-status rollup.
- **Go through the wrappers**, never the native lib directly:
  - haptics → `lib/haptics.ts` (`hapticSelection/Impact/Success/Warning`)
  - liquid glass → `components/GlassSurface.tsx` (`isLiquidGlassAvailable` fallback)
  - icons → `components/IconSymbol.tsx` (SF Symbol on iOS, unicode glyph elsewhere)

## Routing (expo-router)

- File-based under `app/`. Route groups `(tabs)`, `(projects)` are hidden from URLs.
- Native bottom tabs: `expo-router/unstable-native-tabs`. Only `NativeTabs` and
  `NativeTabTrigger` are named exports; icons/labels/badges are compound:
  `NativeTabs.Trigger.Icon` (`sf` + `drawable` props), `.Label`, `.Badge`.
- Per-screen header/title/headerLeft: render `<Stack.Screen options={...} />` inside the
  screen (typed routes are on, so `router.push({ pathname, params })` is type-checked).
- Header-**right** uses module-level renderers so hook-owning buttons remain stable.
  Project root and chat use `NewWorktreeButton` "+" for the New Worktree sheet; worktree
  screens use `LaunchAgentButton` "+" for the Launch Agent sheet. The all-projects list
  has no header button; the stack's native back button handles escaping the drill-down.

## Styling (NativeWind v4 + React Native Reusables)

- Theme tokens are CSS variables in `global.css` (light + `.dark:root`), surfaced through
  `tailwind.config.js`. Use semantic classes (`bg-card`, `text-muted-foreground`,
  `bg-success`), not raw colors.
- `babel.config.js` needs `jsxImportSource: "nativewind"` and the
  `react-native-worklets/plugin` **last**. `metro.config.js` wraps `withNativeWind` and
  watches the monorepo root — don't drop that when editing Metro config.
- Add primitives with `npx @react-native-reusables/cli@latest add <name>`; they land in
  `components/ui/` and depend on `@rn-primitives/*`, `class-variance-authority`, `cn()`.

## Inbox card gesture

`components/InboxCard.tsx` uses `ReanimatedSwipeable`. Swiping **right** reveals the LEFT
action = approve/submit; swiping **left** = deny (`onSwipeableOpen(direction)` where
`direction === "left"` means the left action opened). Submitting a question requires a
selected radio option or non-empty "Other" text, else it warns and snaps back. Every
resolution fires haptics and dismisses the card.

## Gotchas

- **Bun linker must be hoisted.** Root `bunfig.toml` sets `[install] linker = "hoisted"`.
  Bun's default isolated linker hides Expo's Babel plugins from Node resolution and Metro
  fails with `Cannot find module 'babel-preset-expo'`. Don't remove it.
- Reanimated 4 requires `react-native-worklets` (separate package) + its babel plugin.
- SF Symbols only render on iOS; always pass an `IconSymbol` `fallback` glyph for Android/web.
- `@pragma/constants` exports source TS that imports a generated file — run
  `bun run generate` (or `bun run typecheck` from root, which generates first) before
  `tsc` in this app will resolve the types.
