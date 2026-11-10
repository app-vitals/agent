/**
 * admin/src/github-app-jwt.ts
 * RS256 signer for GitHub App JWTs (node:crypto only, no dependencies).
 * https://docs.github.com/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 *
 * Errors never include the private key material.
 */

import { createPrivateKey, sign } from "node:crypto";

/** Backdate iat to absorb clock drift (GitHub's recommendation). */
const IAT_BACKDATE_SECONDS = 60;
/** exp - now. GitHub rejects a JWT whose exp is more than 10 minutes out. */
const EXP_SECONDS = 540;

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function signGithubAppJwt(opts: {
  appId: string;
  privateKey: string;
  now?: Date;
}): string {
  if (!opts.appId) throw new Error("GitHub App JWT: appId is required");
  const nowS = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: opts.appId,
      iat: nowS - IAT_BACKDATE_SECONDS,
      exp: nowS + EXP_SECONDS,
    }),
  );
  const signingInput = `${header}.${payload}`;
  try {
    const key = createPrivateKey(opts.privateKey);
    const sig = sign("RSA-SHA256", Buffer.from(signingInput), key);
    return `${signingInput}.${b64url(sig)}`;
  } catch {
    // Deliberately drop the underlying error: it can carry key details.
    throw new Error("GitHub App JWT: invalid or unusable RSA private key");
  }
}
