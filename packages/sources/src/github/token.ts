import { execFile } from "node:child_process";

/**
 * Finds a GitHub token: $GITHUB_TOKEN, then $GH_TOKEN, then the GitHub CLI's
 * stored login (`gh auth token`). Returns undefined when none is available;
 * unauthenticated requests still work with a much smaller rate limit.
 */
export async function resolveGitHubToken(
  env: NodeJS.ProcessEnv = process.env,
  runGh: () => Promise<string> = ghAuthToken,
): Promise<string | undefined> {
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const token = (await runGh()).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function ghAuthToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token"], { timeout: 3000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
