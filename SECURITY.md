# Security Policy

Thanks for taking the time to report a problem responsibly.

## Reporting a vulnerability

**Report it privately through the support form: https://pragma-app.sh/support** — pick the
topic **"A security or privacy concern"**. That form is the whole channel; there is no
published support mailbox, because a mailbox nobody reads is worse than a form that
demonstrably works.

**Do not open a public issue, pull request, or discussion for a vulnerability.** The
[issue tracker](https://github.com/pragma-sh/pragma/issues) is the right place for
everything else, including a hardening idea that is not exploitable.

Please include, as far as you have it:

- What an attacker gets — the impact, not just the misbehaviour.
- The affected component: the desktop app, `pragma-server`, `pragma-gateway`,
  `pragma-cli`, Pragma Go, one of the `packages/*` plugins, or the website.
- The version you saw it on (the desktop app's About panel, or a commit SHA) and the
  operating system, since macOS, Linux, and Windows take different code paths.
- Steps to reproduce, plus a proof of concept if you have one.

## What to expect

|             |                                                           |
| ----------- | --------------------------------------------------------- |
| First reply | Within **2 business days**                                |
| Fix         | Shipped in the next release once the assessment is agreed |

We will tell you when the fix ships and credit you in the release notes unless you ask us
not to. Please give us a chance to ship before you publish.

## Design decisions that are not vulnerabilities

These are deliberate and documented. Reporting one is welcome as a discussion, but it will
not be treated as a vulnerability:

- **Pragma runs the commands you tell it to run.** Terminal sessions, project lifecycle
  scripts in `.pragma/scripts.json`, automations, and coding agents all execute arbitrary
  code with your own user's privileges by design. Opening an untrusted repository in
  Pragma is equivalent to running its scripts yourself.
- **Plugins are code you install.** A `.pragma/config.json` plugin, like any npm
  dependency, runs unsandboxed.
- **The gateway's `/web` base path is unauthenticated on purpose.** A browser cannot
  attach a bearer token to a `<script src>`, so the Pragma Go web bundle is served as the
  public code it is. Every `/v1` route stays behind the pairing token.
- **Exposing the gateway to the internet is your decision.** The remote-access tunnel is
  opt-in and the pairing token is the only thing protecting it. Treat a pairing link,
  which carries the token in its URL fragment, as a credential.

Reports about a dependency's published advisory are more useful as a pull request or an
issue that bumps it.
