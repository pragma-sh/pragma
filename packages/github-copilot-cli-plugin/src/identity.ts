import {
  credentialDir,
  readCredentialFile,
  type AccountContext,
  type AccountIdentity,
} from "@pragma-sh/plugin/catalog";

/**
 * Reports the GitHub user Copilot CLI is signed in as, from `config.json` in
 * `$COPILOT_HOME` (default `~/.copilot`). The token itself stays in the system
 * credential store; the config records only who it belongs to.
 */
export async function identifyCopilotAccount(
  ctx: Pick<AccountContext, "account">,
): Promise<AccountIdentity | null> {
  const dir = await credentialDir(ctx, "COPILOT_HOME", "~/.copilot");
  return parseCopilotConfig(await readCredentialFile(`${dir}/config.json`));
}

/**
 * Picks the signed-in github.com user from Copilot CLI's config. The id is
 * the lowercased login, the same id OpenCode and Pi Copilot sign-ins get from
 * the GitHub API, so the accounts merge.
 */
export function parseCopilotConfig(config: Record<string, unknown> | null): AccountIdentity | null {
  if (!config) return null;
  const users = [
    config.last_logged_in_user,
    ...(Array.isArray(config.logged_in_users) ? config.logged_in_users : []),
  ];
  for (const user of users) {
    if (typeof user !== "object" || user === null) continue;
    const { host, login } = user as { host?: unknown; login?: unknown };
    if (typeof login !== "string" || !login.trim() || !isGitHubDotCom(host)) continue;
    return { id: login.trim().toLowerCase(), name: login.trim() };
  }
  return null;
}

function isGitHubDotCom(host: unknown): boolean {
  if (host === undefined) return true;
  if (typeof host !== "string") return false;
  return host.replace(/^https?:\/\//, "").replace(/\/$/, "") === "github.com";
}
