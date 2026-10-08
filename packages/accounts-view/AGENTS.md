# `@pragma-sh/accounts-view`

The client-side view model over the host's `accounts` RPC, shared by the desktop
(`apps/pragma`) and Pragma Go (`apps/pragma-go`). Source-only and private: both
apps import `src/index.ts` directly.

## Files

| File              | Holds                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/store.ts`    | `ProjectAccounts`: one host's list + usage, per-account refresh cadence and backoff, subscribe/getSnapshot   |
| `src/accounts.ts` | Provider → account → harness views, which accounts a harness can switch to (`harnessAccountChoices`), scopes |
| `src/usage.ts`    | Usage-limit presentation: percent, severity, reset countdown, primary limit, result validation               |

## What belongs here, and what does not

- **Here:** anything both clients must agree on about accounts — grouping,
  ordering, who can use which account, how a reading is validated and summarised.
- **Not here:** styling (each app maps `usageSeverity` onto its own classes),
  React bindings, or how a client reaches the host (`AccountsApi` is injected).
- **Never resolve bindings here.** The host's `effective` and `loginKeys` are the
  truth; this package only presents them.
- **No `Array.prototype.toSorted`.** Pragma Go runs this on Hermes, which does not
  provide it yet; sort a fresh copy instead.
- The usage-limit wire types live in `@pragma-sh/constants`; this package only
  reads them.
