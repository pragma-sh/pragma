<div align="center">

<h1>Pragma — Run teams of coding agents in parallel.</h1>

<p>Run Claude Code, Codex, OpenCode, Cursor and more each in their own worktree.<br />
Agents, terminals, diffs, and pull requests in one workspace.</p>

<p>
  <a href="https://pragma-app.sh/download/darwin-aarch64"><img src="https://img.shields.io/badge/Download-macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" /></a>
  <a href="https://pragma-app.sh/download/windows-x86_64"><img src="https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows" /></a>
  <a href="https://pragma-app.sh/download/linux-x86_64-deb"><img src="https://img.shields.io/badge/Download-Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download for Linux" /></a>
  <a href="https://apps.apple.com/us/app/pragma-sh-go/id6804842149"><img src="https://img.shields.io/badge/Download%20on%20the-App%20Store-0D96F6?style=for-the-badge&logo=appstore&logoColor=white" alt="Download Pragma Go on the App Store" /></a>
  <a href="#android-with-obtainium"><img src="https://img.shields.io/badge/Get%20it%20on-Obtainium-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="Get Pragma Go on Obtainium" /></a>
</p>

<video src="https://github.com/user-attachments/assets/9cf9e8cd-8afb-4837-a2b0-ecd5a9ff2511" controls width="100%"></video>

<p>
  <a href="https://pragma-app.sh">Website</a>
  &nbsp;·&nbsp;
  <a href="https://pragma-app.sh/docs">Documentation</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/pragma-sh/pragma/releases/latest">Download</a>
  &nbsp;·&nbsp;
  <a href="https://pragma-app.sh/plugins">Plugins</a>
  &nbsp;·&nbsp;
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

<p>
  <a href="https://github.com/pragma-sh/pragma/releases/latest"><img src="https://img.shields.io/github/v/release/pragma-sh/pragma?filter=pragma-v*&style=flat-square&label=release&color=0B7285" alt="Latest release" /></a>
  <a href="https://github.com/pragma-sh/pragma/releases"><img src="https://img.shields.io/github/downloads/pragma-sh/pragma/total?style=flat-square&label=downloads&logo=github&color=0B7285" alt="Total downloads" /></a>
  <a href="https://github.com/pragma-sh/pragma/releases/latest"><img src="https://img.shields.io/github/downloads/pragma-sh/pragma/latest/total?style=flat-square&label=latest%20downloads&logo=github&color=0B7285" alt="Downloads of the latest release" /></a>
</p>

<p>
  <a href="./packages/claude-code-plugin"><img src="https://img.shields.io/badge/Claude%20Code-plugin-D97757?style=flat-square&logo=claude&logoColor=white" alt="Claude Code plugin" /></a>
  <a href="https://pragma-app.sh/docs/plugins"><img src="https://img.shields.io/badge/OpenCode%20%C2%B7%20Codex%20%C2%B7%20Cursor%20%2B7-agent%20plugins-6C5CE7?style=flat-square&logo=opencode&logoColor=white" alt="10 agent plugins" /></a>
  <a href="./skills"><img src="https://img.shields.io/badge/Agent%20Skills-pragma-8B5CF6?style=flat-square&logo=anthropic&logoColor=white" alt="Agent Skills" /></a>
</p>

<p>
  <a href="https://github.com/pragma-sh/pragma/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/pragma-sh/pragma/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white" alt="CI status" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/pragma-sh/pragma?style=flat-square&color=0B7285" alt="License: AGPL-3.0-only" /></a>
  <img src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-1c1c1e?style=flat-square&logo=apple&logoColor=white" alt="Platforms: macOS, Linux, Windows" />
  <a href="https://v2.tauri.app"><img src="https://img.shields.io/badge/Tauri%20v2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Built with Tauri v2" /></a>
  <img src="https://img.shields.io/badge/Rust-CE422B?style=flat-square&logo=rust&logoColor=white" alt="Rust" />
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-000000?style=flat-square&logo=bun&logoColor=white" alt="Bun" /></a>
</p>

</div>

---

## Table of Contents

- [Why Pragma?](#why-pragma)
- [Quick Start](#quick-start)
- [Features](#features)
- [Supported Agents](#supported-agents)
- [Download](#download)
- [Documentation](#documentation)
- [Build From Source](#build-from-source)
- [Repository Map](#repository-map)
- [Contributing](#contributing)
- [License](#license)

## Why Pragma?

You can start five agents in a normal terminal window but it becomes hard to see which agent is doing what. Worse if you are running multipile agents in the same project their changes may collide.

Pragma is an open-source agentic development environment for people running many agents in parallel. Projects, worktrees, terminals, files, diffs, pull requests, and agent status live in one workspace — while every coding agent keeps running through its own native TUI, exactly as its authors shipped it.

There are many tools like Pragma so here is a comparison:

| Capability                                                                                  | Pragma                                   | Emdash     | Orca                                | Superset                      |
| ------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------- | ----------------------------------- | ----------------------------- |
| **Native shell**<br>Rust host + the OS webview, not a bundled browser                       | **Tauri + Rust**                         | Electron   | Electron                            | Electron                      |
| **Agents as plugins**<br>Each integration a versioned package with official branding        | **✅**                                   | 🟡         | 🟡                                  | 🟡                            |
| **Public plugin API**<br>Third-party sidebar tabs, cards, web views, and commands           | **✅**                                   | ❌         | ❌                                  | ❌                            |
| **Programmable automations**<br>Your TypeScript on host events, not just a schedule         | **✅**                                   | 🟡         | 🟡                                  | 🟡                            |
| **Interactive scratchpads**<br>Agents write MDX with live React you can edit and comment on | **✅**                                   | ❌         | ❌                                  | ❌                            |
| **Agent board**<br>Prompt to review to pull request as tracked cards                        | **✅**                                   | ❌         | ❌                                  | ✅                            |
| **Fanout + comparison view**<br>One prompt into N attempts, compared side by side           | **✅**                                   | ❌         | ✅                                  | 🟡                            |
| **Editing suite**<br>Code, markdown WYSIWYG, PDF, image, video, and audio                   | **✅**                                   | 🟡         | 🟡                                  | 🟡                            |
| **Built-in AI, your key**<br>Inline ⌘K edits, one-click PR drafting, ask from the palette   | **✅**                                   | ❌         | 🟡                                  | ❌                            |
| **Mobile and web client**<br>What ships, and how you reach it off your LAN                  | **iOS, Android, Web**<br>your own tunnel | ❌         | iOS, Android<br>needs Tailscale/VPS | iOS only, Pro<br>hosted relay |
| **Persistent host server**<br>Sessions, tunnels, headless launches survive quitting         | **✅**                                   | 🟡         | 🟡                                  | 🟡                            |
| **Remote projects**<br>SSH hosts as first-class remote projects                             | **SSH**                                  | SSH        | SSH + WSL                           | ❌                            |
| **User themes**<br>Editable colour tokens per project, not a fixed preset list              | **✅**                                   | 🟡         | 🟡                                  | 🟡                            |
| **License**<br>What you may do with the source                                              | **AGPL-3.0**                             | Apache-2.0 | MIT                                 | Elastic 2.0                   |

✅ yes  ·  🟡 partial  ·  ❌ no

Checked against the `generalaction/emdash`, `stablyai/orca`, and `superset-sh/superset` repositories as of 2026-08-29. These projects ship fast — if something here is out of date, open an issue and we will correct it. On the mobile row: Pragma's tunnel is a command you supply and control (ngrok, cloudflared, a Tailscale funnel — whatever you already run), not a vendor relay you depend on. Orca has no tunnel of its own; remote access means installing Tailscale yourself or running Orca's full server on a VPS. Superset's reaches your machine through Superset's own hosted relay, and the iOS app is Pro-plan only.

## Quick Start

1. [Download Pragma](#download) for macOS, Windows, or Linux and install it.
2. Add a project — any git checkout — from the bottom of the sidebar.
3. Create a worktree, pick an agent, and type a prompt.

The [quick start guide](https://pragma-app.sh/docs/user-guide/quick-start) walks through the full loop from first prompt to merged pull request.

## Features

### 🌿 Parallel by default

Launch Claude Code, Codex, OpenCode, Cursor, and friends in separate branches and worktrees. No collisions, no stashing, no "wait, which agent touched this file?"

### 🔀 Fanout — one prompt, many attempts

Send a single prompt to several isolated attempts, compare their terminals, diffs, and scratchpads side by side, then keep the strongest result and throw the rest away.

### 🔌 Persistent sessions

Terminals and scrollback live on the host, not in the window. Close the app, drop the network, move to another machine — the agent keeps working and the scrollback is still there.

### 🔍 One review surface

Inspect diffs, stage files, commit, push branches, and manage GitHub pull requests beside the agent that wrote the code.

### 🛰️ Local-first, and anywhere

Run on your machine, over SSH, or inside WSL. Desktop app on macOS, Linux, and Windows, with companion access from iOS, Android, and the browser.

### 🧩 Extensible

Plugins add UI, commands, agents, and themes. Automations run scheduled and event-driven host tasks. The CLI and the typed `@pragma-sh/sdk` drive all of it from scripts.

[**▶ Watch the feature tour →**](https://pragma-app.sh)

## Supported Agents

Every agent runs through its own native CLI. Pragma adds a plugin so it reports status and shows up in the launcher.

Missing yours? Agent plugins are ordinary TypeScript packages — see the [plugin guide](https://pragma-app.sh/docs/plugins).

## Download

Signed installers for every platform are attached to each [GitHub Release](https://github.com/pragma-sh/pragma/releases/latest). The links below always fetch the newest one.

| Platform | Download                                                                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | [Apple silicon (.dmg)](https://pragma-app.sh/download/darwin-aarch64) · [Intel (.dmg)](https://pragma-app.sh/download/darwin-x86_64)                                                                                                                |
| Windows  | [x64 installer (.exe)](https://pragma-app.sh/download/windows-x86_64)                                                                                                                                                                               |
| Linux    | x64: [.deb](https://pragma-app.sh/download/linux-x86_64-deb) · [.rpm](https://pragma-app.sh/download/linux-x86_64-rpm) — ARM64: [.deb](https://pragma-app.sh/download/linux-aarch64-deb) · [.rpm](https://pragma-app.sh/download/linux-aarch64-rpm) |

Pragma updates itself in place once installed. Release notes and older builds are on the [releases page](https://github.com/pragma-sh/pragma/releases).

### Pragma Go (mobile)

Pragma Go pairs with your desktop so you can launch agents, watch sessions, and answer their questions from your phone — see the [mobile guide](https://pragma-app.sh/docs/user-guide/mobile).

- **Android** — install and auto-update the APK with [Obtainium](#android-with-obtainium).
- **iOS** — [download Pragma Go on the App Store](https://apps.apple.com/us/app/pragma-sh-go/id6804842149).
- **Web** — served by your desktop; turn on **Enable web access** under Settings → Pragma Go.

#### Android with Obtainium

[Obtainium](https://github.com/ImranR98/Obtainium) installs Android apps straight from their GitHub releases and keeps them updated.

1. Install Obtainium from its [releases page](https://github.com/ImranR98/Obtainium/releases/latest) or F-Droid.
2. Tap **Add app** and enter `https://github.com/pragma-sh/pragma` as the source URL.
3. This repository also publishes desktop and plugin releases, so set:
   - **Filter release titles by regular expression** → `^pragma-go`
   - **Filter APKs by regular expression** → `\.apk$`
   - **Fallback to older releases** → on
   - **Version detection** → **Use release date as version string**
4. Tap **Add**, then **Install**. Obtainium notifies you whenever a new Pragma Go release is published.

The [Android install guide](https://pragma-app.sh/docs/user-guide/mobile#android-with-obtainium) explains each option and why it is needed.

## Documentation

| Resource                                                    | What it covers                                         |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| [Website](https://pragma-app.sh)                            | Product overview and feature tour                      |
| [Documentation](https://pragma-app.sh/docs)                 | Main documentation hub                                 |
| [User guide](https://pragma-app.sh/docs/user-guide)         | Projects, worktrees, agents, review, and settings      |
| [CLI reference](https://pragma-app.sh/docs/cli)             | Control Pragma and report agent status from a terminal |
| [TypeScript SDK](https://pragma-app.sh/docs/sdk)            | Build typed integrations with `@pragma-sh/sdk`         |
| [Plugin development](https://pragma-app.sh/docs/plugins)    | Add UI, commands, agents, themes, and integrations     |
| [Plugin gallery](https://pragma-app.sh/plugins)             | Browse available Pragma plugins                        |
| [Automations](https://pragma-app.sh/docs/automations)       | Run scheduled and event-driven host tasks              |
| [Architecture wiki](https://pragma-app.sh/docs/wiki)        | Desktop, server, gateway, and protocol layers          |
| [Issue tracker](https://github.com/pragma-sh/pragma/issues) | Report bugs and request features                       |

## Build From Source

Prerequisites:

- [Bun](https://bun.sh/) 1.3.14 or newer
- Stable [Rust toolchain](https://www.rust-lang.org/tools/install) with clippy and rustfmt
- [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

```bash
git clone https://github.com/pragma-sh/pragma.git
cd pragma
bun install
bun run dev
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for mobile, web, and docs dev workflows.

## Contributing

Read **[CONTRIBUTING.md](./CONTRIBUTING.md)** first — it covers the contribution policy, prerequisites, running the desktop app and Pragma Go, the project tour, style guidelines, commit style, and how to open a pull request.

**Policy in short: we only accept small features.** Bug fixes and other small, focused changes are the most likely to be merged; large features and sweeping refactors will almost certainly be declined. Open an issue before building anything non-trivial.

Before opening a pull request:

```bash
bun run check
bun run test
bun run rust:test
```

Use [Conventional Commits](https://www.conventionalcommits.org/) and include focused tests with behavior changes. `AGENTS.md` (and the per-package `AGENTS.md` files) hold the deeper architecture and platform rules for human and AI contributors alike. Bugs and ideas start in the [issue tracker](https://github.com/pragma-sh/pragma/issues).

## License

[GNU Affero General Public License v3.0](./LICENSE).

**If Pragma saves you a tab, [give it a star](https://github.com/pragma-sh/pragma/stargazers). ⭐**

Built with Tauri, Rust, React, and Bun.
