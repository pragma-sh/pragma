# `@pragma/github-helpers` - GitHub Sidecar

Host-side GitHub helper package compiled to the `pragma-github` Bun sidecar.

## Responsibilities

- Own the Octokit-based GitHub operations behind `pragma-server`'s `github` RPC.
- Read the token from the environment (`PRAGMA_GITHUB_TOKEN`), never an
  argument — arguments are visible in a process listing.
- Communicate with Rust over a small JSON/NDJSON command surface.

## Pull requests

`pull-requests.ts` holds the two rules worth stating:

- **Lookup matches repository plus exact head branch**, in any state. That is
  what makes a pull request opened outside Pragma appear, and merged is reported
  separately from closed because a merged branch is finished, not abandoned.
- **A duplicate create is a success.** GitHub answers a second create for the
  same head with a 422; the pull request the caller wanted exists, so the
  existing one is returned rather than an error that invites a retry into the
  same wall.

- **Branches are listed here, not in a client.** `branches` answers the
  base-branch picker every client needs; the token never leaves the host, so a
  phone cannot call GitHub itself.

## Rules

- This package must not run in the frontend.
- Server code spawns the compiled `pragma-github` sidecar and proxies GitHub RPC.
- Keep the Rust/server command shape in sync whenever `src/cli.ts` changes.

## Commands

```sh
bun run typecheck
bun run test
bun run lint
bun run build:sidecar
```
