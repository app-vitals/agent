/**
 * admin/src/slack-config-token.ts
 * SlackConfigTokenService — storage for the Slack app-configuration token
 * (refresh token plus short-lived access token), scoped like AgentTemplate:
 * accountId null = deployment-wide default, an account row overrides it.
 *
 * Tokens are encrypted on write (AES-256-GCM via a strict TokenCrypto) and are
 * never returned by any read path: reads return metadata plus `*Set` flags.
 * save() refuses when no encryption key is configured (no plain-text fallback).
 *
 * getAccessToken() is the only path that decrypts. It serves the cached access
 * token while it has more than 10 minutes left; otherwise it rotates via
 * tooling.tokens.rotate under a row lock (SELECT ... FOR UPDATE) so replicas
 * serialize, persists the new pair, and returns the access token only after
 * that write commits. Slack rotation revokes the access token issued with the
 * refresh token used, so a second rotate would break the first caller's token;
 * the lock plus the cache re-check prevents that.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import { type Clock, SystemClock } from "./clock.ts";
import {
  BadGatewayError,
  NotFoundError,
  UnprocessableEntityError,
} from "./errors.ts";
import type { SlackConfigTokenClient } from "./slack-provisioning-client.ts";
import type { TokenCrypto } from "./token-crypto.ts";

/** A cached access token is reused only while it has more than this left. */
export const SLACK_CONFIG_ACCESS_TOKEN_MIN_REMAINING_MS = 10 * 60 * 1000;

/**
 * Interactive transaction timeout for a rotation. The row lock is held across
 * the Slack call, so this must exceed it; waiters queue on the lock inside
 * their own transaction, so it also bounds how long they wait.
 */
const ROTATE_TX_TIMEOUT_MS = 30_000;
const ROTATE_TX_MAX_WAIT_MS = 10_000;

export interface GetSlackConfigAccessTokenOptions {
  /**
   * Rotate even when the cached access token is still valid. Used for the one
   * retry after Slack rejected the token (token_revoked / invalid_auth).
   */
  forceRotate?: boolean;
  /**
   * With forceRotate: the access token Slack rejected. If, once the row lock is
   * held, the stored access token is a different still-valid token, another
   * caller already rotated past the rejected one and that token is returned
   * without a second rotate (which would revoke it). Without this, forceRotate
   * always rotates.
   */
  rejectedAccessToken?: string;
}

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

/** No SlackConfigToken row exists for the requested scope. */
export class SlackConfigTokenNotConfiguredError extends NotFoundError {
  constructor(accountId: string | null) {
    super(
      accountId === null
        ? "No deployment-wide Slack config token is configured"
        : `No Slack config token is configured for account ${accountId}`,
    );
    this.name = "SlackConfigTokenNotConfiguredError";
  }
}

/** Slack rejected the stored refresh token; a human must regenerate it. */
export class SlackConfigRefreshTokenInvalidError extends UnprocessableEntityError {
  constructor() {
    super(
      "The stored Slack config refresh token is no longer valid (invalid_refresh_token). Regenerate the App Configuration token in Slack (api.slack.com/apps, Your App Configuration Tokens) and save the new refresh token in agent admin settings.",
    );
    this.name = "SlackConfigRefreshTokenInvalidError";
  }
}

/** tooling.tokens.rotate failed for any other reason. Carries the Slack/HTTP code only. */
export class SlackConfigTokenRotateFailedError extends BadGatewayError {
  constructor(public readonly code: string) {
    super(`Slack config token rotation failed: ${code}`);
    this.name = "SlackConfigTokenRotateFailedError";
  }
}

const REVOKED_CODES = new Set(["token_revoked", "invalid_auth"]);

/**
 * True when `err` is Slack rejecting an access token (token_revoked or
 * invalid_auth). Matches a `.code` (SlackConfigTokenError) and the plain
 * `Error("Slack <method> failed: <code>")` that HttpSlackProvisioningClient's
 * manifest calls throw.
 */
export function isSlackConfigTokenRevokedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && REVOKED_CODES.has(code)) return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  const m = /\bfailed: ([a-z_]+)\s*$/.exec(message);
  return !!m && REVOKED_CODES.has(m[1] as string);
}

function rotateErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  // Codes come from Slack's `error` field or the client's own constants; keep
  // only a safe identifier so lastError can never carry token material.
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/i.test(code)
    ? code
    : "unknown_error";
}

type RotateOutcome =
  | { kind: "token"; accessToken: string }
  | { kind: "rotateFailed"; code: string };

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
    /** tooling.tokens.rotate client; required by getAccessToken() only. */
    private rotateClient?: SlackConfigTokenClient,
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

  /**
   * Server-side only: a usable Slack config access token for exactly this
   * scope (no fallback to the default; callers resolve the scope first, e.g.
   * via resolveForAccount). Never logged; errors never contain token values.
   */
  async getAccessToken(
    accountId: string | null,
    opts: GetSlackConfigAccessTokenOptions = {},
  ): Promise<string> {
    const crypto = this.crypto;
    if (!crypto) throw new SlackConfigTokenEncryptionUnavailableError();
    const rotateClient = this.rotateClient;
    if (!rotateClient) {
      throw new Error(
        "SlackConfigTokenService was constructed without a SlackConfigTokenClient; getAccessToken() cannot rotate",
      );
    }

    const forceRotate = opts.forceRotate === true;
    if (!forceRotate) {
      const row = await this.prisma.slackConfigToken.findFirst({
        where: { accountId },
      });
      if (!row) throw new SlackConfigTokenNotConfiguredError(accountId);
      const cached = this.cachedAccessToken(row, crypto);
      if (cached) return cached;
    }

    const outcome = await this.prisma.$transaction(
      async (tx): Promise<RotateOutcome> => {
        const locked =
          accountId === null
            ? await tx.$queryRaw<
                { id: string }[]
              >`SELECT id FROM "SlackConfigToken" WHERE "accountId" IS NULL FOR UPDATE`
            : await tx.$queryRaw<
                { id: string }[]
              >`SELECT id FROM "SlackConfigToken" WHERE "accountId" = ${accountId} FOR UPDATE`;
        const id = locked[0]?.id;
        if (!id) throw new SlackConfigTokenNotConfiguredError(accountId);
        const row = await tx.slackConfigToken.findUniqueOrThrow({
          where: { id },
        });

        // Re-check under the lock: another caller (or replica) may have
        // rotated while we waited. A forced rotate reuses that token only if
        // it is not the one Slack just rejected.
        const cached = this.cachedAccessToken(row, crypto);
        if (cached) {
          if (!forceRotate) return { kind: "token", accessToken: cached };
          if (
            opts.rejectedAccessToken !== undefined &&
            cached !== opts.rejectedAccessToken
          ) {
            return { kind: "token", accessToken: cached };
          }
        }

        let rotated: Awaited<
          ReturnType<SlackConfigTokenClient["rotateConfigToken"]>
        >;
        try {
          rotated = await rotateClient.rotateConfigToken(
            crypto.decrypt(row.refreshTokenEncrypted),
          );
        } catch (err) {
          // Record the failure and commit it; throwing here would roll the
          // lastError write back. Token columns are left untouched.
          const code = rotateErrorCode(err);
          await tx.slackConfigToken.update({
            where: { id },
            data: { lastError: code, updatedAt: this.clock.now() },
          });
          return { kind: "rotateFailed", code };
        }

        // Persist before returning: if this write (or the commit) fails, the
        // caller gets an error, never an access token we failed to store.
        // Slack refresh tokens are not single-use, so the still-stored old
        // refresh token keeps working for the next attempt.
        const now = this.clock.now();
        try {
          await tx.slackConfigToken.update({
            where: { id },
            data: {
              refreshTokenEncrypted: crypto.encrypt(rotated.refreshToken),
              accessTokenEncrypted: crypto.encrypt(rotated.accessToken),
              accessTokenExpiresAt: new Date(rotated.exp * 1000),
              slackTeamId: rotated.teamId,
              slackUserId: rotated.userId,
              lastRotatedAt: now,
              lastError: null,
              updatedAt: now,
            },
          });
        } catch (err) {
          throw new Error(
            "Failed to persist the rotated Slack config token; the access token was discarded",
            { cause: err },
          );
        }
        return { kind: "token", accessToken: rotated.accessToken };
      },
      { timeout: ROTATE_TX_TIMEOUT_MS, maxWait: ROTATE_TX_MAX_WAIT_MS },
    );

    if (outcome.kind === "rotateFailed") {
      if (outcome.code === "invalid_refresh_token") {
        throw new SlackConfigRefreshTokenInvalidError();
      }
      throw new SlackConfigTokenRotateFailedError(outcome.code);
    }
    return outcome.accessToken;
  }

  /**
   * Run `fn` with this scope's access token. If Slack rejects the token
   * (token_revoked / invalid_auth), force exactly one rotate and retry `fn`
   * once; a second failure propagates. No loop.
   */
  async withSlackConfigAccessToken<T>(
    accountId: string | null,
    fn: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const accessToken = await this.getAccessToken(accountId);
    try {
      return await fn(accessToken);
    } catch (err) {
      if (!isSlackConfigTokenRevokedError(err)) throw err;
      const fresh = await this.getAccessToken(accountId, {
        forceRotate: true,
        rejectedAccessToken: accessToken,
      });
      return fn(fresh);
    }
  }

  /** Decrypted cached access token if it has more than the minimum left. */
  private cachedAccessToken(
    row: SlackConfigTokenRow,
    crypto: TokenCrypto,
  ): string | null {
    if (!row.accessTokenEncrypted || !row.accessTokenExpiresAt) return null;
    const remaining =
      row.accessTokenExpiresAt.getTime() - this.clock.now().getTime();
    if (remaining <= SLACK_CONFIG_ACCESS_TOKEN_MIN_REMAINING_MS) return null;
    return crypto.decrypt(row.accessTokenEncrypted);
  }
}

/**
 * The slice of SlackConfigTokenService the create / connect / sync / delete
 * flows need. Flows take it as an optional dependency: absent means no stored
 * token and today's paste-only behavior.
 */
export type SlackConfigTokenResolver = Pick<
  SlackConfigTokenService,
  "get" | "resolveForAccount" | "withSlackConfigAccessToken"
>;

async function resolveStoredScope(
  resolver: SlackConfigTokenResolver | undefined,
  accountId: string | null | undefined,
): Promise<SlackConfigTokenMetadata | null> {
  if (!resolver) return null;
  return accountId ? resolver.resolveForAccount(accountId) : resolver.get(null);
}

/**
 * True when a stored config token applies to this account: its own row, else
 * the deployment-wide default row (a null account only sees the default).
 */
export async function hasStoredSlackConfigToken(
  resolver: SlackConfigTokenResolver | undefined,
  accountId: string | null | undefined,
): Promise<boolean> {
  return (await resolveStoredScope(resolver, accountId)) !== null;
}

/**
 * Run `fn` with a Slack config token: a pasted token wins (used as-is, no
 * retry); otherwise mint an access token from the account's stored row, else
 * the default row, with the revoked-token retry-once of
 * withSlackConfigAccessToken. Throws SlackConfigTokenNotConfiguredError when
 * neither exists, so callers check hasStoredSlackConfigToken() first when they
 * have a paste-only fallback.
 */
export async function withSlackConfigToken<T>(
  resolver: SlackConfigTokenResolver | undefined,
  opts: { pasted?: string | undefined; accountId?: string | null | undefined },
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const pasted = opts.pasted?.trim();
  if (pasted) return fn(pasted);
  const row = await resolveStoredScope(resolver, opts.accountId);
  if (!row || !resolver) {
    throw new SlackConfigTokenNotConfiguredError(opts.accountId ?? null);
  }
  return resolver.withSlackConfigAccessToken(row.accountId, fn);
}
