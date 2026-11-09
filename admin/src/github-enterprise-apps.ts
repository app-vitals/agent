/**
 * admin/src/github-enterprise-apps.ts
 * GitHubEnterpriseAppService — storage for the two optional admin-level GitHub
 * Apps ('installer' and 'lookup'), at most one row per role. No rows means the
 * feature is off.
 *
 * The private key is encrypted on write (AES-256-GCM via TokenCrypto) and is
 * never returned by any read path: reads return metadata plus a `keySet` flag.
 * Only getPrivateKey() decrypts, for server-side use by the app-token minter.
 *
 * Deliberate differences from AgentEnvService:
 *  - save() refuses when no encryption key is configured (no plain-text fallback);
 *  - decrypt is strict (failure throws; ciphertext is never passed on as a PEM);
 *  - separate table, so the key can never reach the agent config bundle;
 *  - no key rotation.
 * Errors never include the PEM.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import { type Clock, SystemClock } from "./clock.ts";
import { ApiError, UnprocessableEntityError } from "./errors.ts";
import type { TokenCrypto } from "./token-crypto.ts";

export const GITHUB_ENTERPRISE_APP_ROLES = ["installer", "lookup"] as const;
export type GitHubEnterpriseAppRole =
  (typeof GITHUB_ENTERPRISE_APP_ROLES)[number];

export interface GitHubEnterpriseAppMetadata {
  role: string;
  appId: string;
  slug: string;
  enterpriseSlug: string | null;
  /** True when an encrypted private key is stored. The key itself is never returned. */
  keySet: boolean;
  lastValidationStatus: string | null;
  lastValidatedAt: Date | null;
  lastValidationError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveGitHubEnterpriseAppInput {
  role: GitHubEnterpriseAppRole;
  appId: string;
  slug: string;
  /** installer only */
  enterpriseSlug?: string | null;
  /** PEM; encrypted before it is stored. */
  privateKey: string;
}

interface GitHubEnterpriseAppRow {
  role: string;
  appId: string;
  slug: string;
  enterpriseSlug: string | null;
  privateKeyEncrypted: string;
  lastValidationStatus: string | null;
  lastValidatedAt: Date | null;
  lastValidationError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class PrivateKeyEncryptionUnavailableError extends UnprocessableEntityError {
  constructor() {
    super(
      "SHIPWRIGHT_ENCRYPTION_KEY is not configured; refusing to store a GitHub App private key unencrypted. Set it to a 64-character hex string (openssl rand -hex 32) and retry.",
    );
    this.name = "PrivateKeyEncryptionUnavailableError";
  }
}

export class PrivateKeyDecryptError extends ApiError {
  constructor(role: string) {
    super(
      500,
      `failed to decrypt the stored private key for GitHub Enterprise App '${role}': the value is corrupt or SHIPWRIGHT_ENCRYPTION_KEY changed; re-save the key`,
    );
    this.name = "PrivateKeyDecryptError";
  }
}

/** Serializer: metadata plus a keySet flag. Never includes key material. */
export function toGitHubEnterpriseAppMetadata(
  row: GitHubEnterpriseAppRow,
): GitHubEnterpriseAppMetadata {
  return {
    role: row.role,
    appId: row.appId,
    slug: row.slug,
    enterpriseSlug: row.enterpriseSlug,
    keySet: row.privateKeyEncrypted.length > 0,
    lastValidationStatus: row.lastValidationStatus,
    lastValidatedAt: row.lastValidatedAt,
    lastValidationError: row.lastValidationError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertRole(role: string): asserts role is GitHubEnterpriseAppRole {
  if (!(GITHUB_ENTERPRISE_APP_ROLES as readonly string[]).includes(role)) {
    throw new UnprocessableEntityError(
      `role must be one of: ${GITHUB_ENTERPRISE_APP_ROLES.join(", ")}`,
    );
  }
}

export class GitHubEnterpriseAppService {
  constructor(
    private prisma: PrismaClient,
    /** Strict crypto (see makeStrictTokenCrypto); null when no encryption key is configured. */
    private crypto: TokenCrypto | null,
    private clock: Clock = SystemClock(),
  ) {}

  /** Create or replace the app for a role. Resets validation state. */
  async save(
    input: SaveGitHubEnterpriseAppInput,
  ): Promise<GitHubEnterpriseAppMetadata> {
    assertRole(input.role);
    if (!this.crypto) throw new PrivateKeyEncryptionUnavailableError();
    if (!input.privateKey) {
      throw new UnprocessableEntityError("privateKey is required");
    }
    const data = {
      appId: input.appId,
      slug: input.slug,
      enterpriseSlug:
        input.role === "installer" ? (input.enterpriseSlug ?? null) : null,
      privateKeyEncrypted: this.crypto.encrypt(input.privateKey),
      lastValidationStatus: null,
      lastValidatedAt: null,
      lastValidationError: null,
      updatedAt: this.clock.now(),
    };
    const row = await this.prisma.gitHubEnterpriseApp.upsert({
      where: { role: input.role },
      create: { role: input.role, ...data },
      update: data,
    });
    return toGitHubEnterpriseAppMetadata(row);
  }

  async get(
    role: GitHubEnterpriseAppRole,
  ): Promise<GitHubEnterpriseAppMetadata | null> {
    assertRole(role);
    const row = await this.prisma.gitHubEnterpriseApp.findUnique({
      where: { role },
    });
    return row ? toGitHubEnterpriseAppMetadata(row) : null;
  }

  async list(): Promise<GitHubEnterpriseAppMetadata[]> {
    const rows = await this.prisma.gitHubEnterpriseApp.findMany({
      orderBy: { role: "asc" },
    });
    return rows.map(toGitHubEnterpriseAppMetadata);
  }

  /** Delete the app for a role. No-ops if absent. */
  async delete(role: GitHubEnterpriseAppRole): Promise<void> {
    assertRole(role);
    await this.prisma.gitHubEnterpriseApp.deleteMany({ where: { role } });
  }

  /**
   * Server-side only: decrypt the stored PEM. Strict — any failure throws
   * PrivateKeyDecryptError (never includes the PEM or ciphertext). Returns
   * null when the role has no row.
   */
  async getPrivateKey(role: GitHubEnterpriseAppRole): Promise<string | null> {
    assertRole(role);
    if (!this.crypto) throw new PrivateKeyEncryptionUnavailableError();
    const row = await this.prisma.gitHubEnterpriseApp.findUnique({
      where: { role },
    });
    if (!row) return null;
    try {
      return this.crypto.decrypt(row.privateKeyEncrypted);
    } catch {
      throw new PrivateKeyDecryptError(role);
    }
  }

  /** Record the outcome of a validation attempt. The error text must not contain key material. */
  async recordValidation(
    role: GitHubEnterpriseAppRole,
    result: { status: string; error?: string | null },
  ): Promise<void> {
    assertRole(role);
    await this.prisma.gitHubEnterpriseApp.updateMany({
      where: { role },
      data: {
        lastValidationStatus: result.status,
        lastValidatedAt: this.clock.now(),
        lastValidationError: result.error ?? null,
        updatedAt: this.clock.now(),
      },
    });
  }
}
