import { Octokit } from "octokit";

/** Creates an Octokit client for a host-side GitHub token. */
export function createGitHubClient(token: string, baseUrl?: string): Octokit {
  return new Octokit({ auth: token, baseUrl });
}

/** Returns the login for the token's authenticated user. */
export async function viewerLogin(token: string, baseUrl?: string): Promise<string> {
  const client = createGitHubClient(token, baseUrl);
  const { data } = await client.rest.users.getAuthenticated();
  return data.login;
}
