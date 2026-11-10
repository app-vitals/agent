import { describe, expect, it } from "bun:test";
import {
  isValidGithubUsername,
  normalizeGithubUsername,
} from "./github-username.ts";

describe("github username syntax (GHE-2.1)", () => {
  it("accepts valid logins", () => {
    for (const ok of [
      "a",
      "octocat",
      "Octo-Cat",
      "a-b-c",
      "a1",
      "a".repeat(39),
    ])
      expect(isValidGithubUsername(ok)).toBe(true);
  });

  it("rejects leading/trailing/consecutive hyphens", () => {
    for (const bad of ["-a", "a-", "a--b", "-"])
      expect(isValidGithubUsername(bad)).toBe(false);
  });

  it("rejects too long, empty and illegal characters", () => {
    for (const bad of ["a".repeat(40), "", "a_b", "a b", "a.b", "é"])
      expect(isValidGithubUsername(bad)).toBe(false);
  });

  it("normalize lower-cases valid input and returns null otherwise", () => {
    expect(normalizeGithubUsername("Octo-Cat")).toBe("octo-cat");
    expect(normalizeGithubUsername("-bad")).toBeNull();
  });
});
