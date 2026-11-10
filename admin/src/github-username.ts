/**
 * GHE-2.1: GitHub login syntax validation. Syntax only — never calls GitHub.
 * A login is 1-39 chars of alphanumerics and single hyphens, with no leading
 * or trailing hyphen (consecutive hyphens are invalid).
 */
const GITHUB_LOGIN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const GITHUB_LOGIN_MAX_LENGTH = 39;

export function isValidGithubUsername(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= GITHUB_LOGIN_MAX_LENGTH &&
    GITHUB_LOGIN_PATTERN.test(value)
  );
}

/** Returns the lower-cased login, or null when the syntax is invalid. */
export function normalizeGithubUsername(value: string): string | null {
  return isValidGithubUsername(value) ? value.toLowerCase() : null;
}
