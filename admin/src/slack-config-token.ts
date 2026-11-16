/**
 * admin/src/slack-config-token.ts
 * SlackConfigTokenService — storage for the Slack app-configuration token
 * (refresh token plus short-lived access token), scoped like AgentTemplate:
 * accountId null = deployment-wide default, an account row overrides it.
 *
 * Tokens are encrypted on write (AES-256-GCM via a strict TokenCrypto) and are
 * never returned by any read path: reads return metadata plus `*Set` flags.
 * save() refuses when no encryption key is configured (no plain-text fallback).
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import { type Clock, SystemClock } from "./clock.ts";
import { UnprocessableEntityError } from "./errors.ts";
import type { TokenCrypto } from "./token-crypto.ts";

export interface SlackConfigTokenMetadata {
  id: string;
  /** null = deployment-wide default. */
  accountId: string | null;
  refreshTokenSet: boolean;
  accessTokenSet: boolean;
  accessTokenExpiresAt: Date | null;
  slackTeamId: string | null;
  slackUserId: string | null;
  lastRotatedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveSlackConfigTokenInput {
  /** Encrypted before it is stored. */
  refreshToken: string;
  /** Encrypted before it is stored. */
  accessToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  slackTeamId?: string | null;
  slackUserId?: string | null;
}

interface SlackConfigTokenRow {
  id: string;
  accountId: string | null;
  refreshTokenEncrypted: string;
  accessTokenEncrypted: string | null;
  accessTokenExpiresAt: Date | null;
  slackTeamId: string | null;
  slackUserId: string | null;
  lastRotatedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class SlackConfigTokenEncryptionUnavailableError extends UnprocessableEntityError {
  constructor() {
    super(
      "SHIPWRIGHT_ENCRYPTION_KEY is not configured; refusing to store a Slack config token unencrypted. Set it to a 64-character hex string (openssl rand -hex 32) and retry.",
    );
    this.name = "SlackConfigTokenEncryptionUnavailableError";
  }
}

/** Serializer: metadata plus set flags. Never includes token material. */
export function toSlackConfigTokenMetadata(
  row: SlackConfigTokenRow,
): SlackConfigTokenMetadata {
  return {
    id: row.id,
    accountId: row.accountId,
    refreshTokenSet: row.refreshTokenEncrypted.length > 0,
    accessTokenSet: !!row.accessTokenEncrypted,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    slackTeamId: row.slackTeamId,
    slackUserId: row.slackUserId,
    lastRotatedAt: row.lastRotatedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

export class SlackConfigTokenService {
  constructor(
    private prisma: PrismaClient,
    /** Strict crypto (see makeStrictTokenCrypto); null when no encryption key is configured. */
    private crypto: TokenCrypto | null,
    private clock: Clock = SystemClock(),
  ) {}

  /**
   * Create or replace the token for a scope (accountId null = deployment-wide
   * default). Resets lastError; stamps lastRotatedAt.
   */
  async save(
    accountId: string | null,
    input: SaveSlackConfigTokenInput,
  ): Promise<SlackConfigTokenMetadata> {
    if (!this.crypto) throw new SlackConfigTokenEncryptionUnavailableError();
    if (!input.refreshToken) {
      throw new UnprocessableEntityError("refreshToken is required");
    }
    const now = this.clock.now();
    const data = {
      refreshTokenEncrypted: this.crypto.encrypt(input.refreshToken),
      accessTokenEncrypted: input.accessToken
        ? this.crypto.encrypt(input.accessToken)
        : null,
      accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
      slackTeamId: input.slackTeamId ?? null,
      slackUserId: input.slackUserId ?? null,
      lastRotatedAt: now,
      lastError: null,
      updatedAt: now,
    };
    // Prisma has no upsert for a nullable-scoped partial unique index, so
    // update-then-create; a concurrent create loses on the index and retries
    // as an update.
    const update = async () => {
      const existing = await this.prisma.slackConfigToken.findFirst({
        where: { accountId },
      });
      if (!existing) return null;
      return this.prisma.slackConfigToken.update({
        where: { id: existing.id },
        data,
      });
    };
    let row = await update();
    if (!row) {
      try {
        row = await this.prisma.slackConfigToken.create({
          data: { accountId, ...data },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        row = await update();
        if (!row) throw err;
      }
    }
    return toSlackConfigTokenMetadata(row);
  }

  /** Metadata for exactly this scope (no fallback), or null. */
  async get(
    accountId: string | null,
  ): Promise<SlackConfigTokenMetadata | null> {
    const row = await this.prisma.slackConfigToken.findFirst({
      where: { accountId },
    });
    return row ? toSlackConfigTokenMetadata(row) : null;
  }

  /** Account row, else the deployment-wide default row, else null. */
  async resolveForAccount(
    accountId: string,
  ): Promise<SlackConfigTokenMetadata | null> {
    return (await this.get(accountId)) ?? (await this.get(null));
  }

  async list(): Promise<SlackConfigTokenMetadata[]> {
    const rows = await this.prisma.slackConfigToken.findMany({
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toSlackConfigTokenMetadata);
  }

  /** Delete the token for a scope. No-ops if absent. */
  async clear(accountId: string | null): Promise<void> {
    await this.prisma.slackConfigToken.deleteMany({ where: { accountId } });
  }
}
