import * as NodeSqlite from "node:sqlite";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

const AuthFile = Schema.Struct({ "opencode-go": Schema.optionalKey(Schema.Unknown) });
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);
// OpenCode 2's database tags a stored key "key"; auth.json tags it "api".
const StoredKey = Schema.Struct({
  type: Schema.Literal("key"),
  key: Schema.String,
  metadata: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ server: Schema.optionalKey(Schema.Unknown) })),
  ),
});
const decodeStoredKey = Schema.decodeOption(Schema.fromJsonString(StoredKey));
const UsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});

const ConsoleMetadata = Schema.Struct({
  server: Schema.optional(Schema.String),
  orgID: Schema.optional(Schema.String),
});
const ConsoleCredential = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("oauth"),
    access: Schema.String,
    metadata: Schema.optional(ConsoleMetadata),
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    key: Schema.String,
    metadata: Schema.optional(ConsoleMetadata),
  }),
]);
const decodeConsoleCredential = Schema.decodeUnknownOption(
  Schema.fromJsonString(ConsoleCredential),
);

const MicroCents = Schema.Union([Schema.String, Schema.Finite]);
const GoMeter = Schema.Struct({
  startsAt: Schema.optional(Schema.NullOr(Schema.String)),
  resetsAt: Schema.optional(Schema.NullOr(Schema.String)),
  limitMicroCents: MicroCents,
  usedMicroCents: MicroCents,
});
const GoStatusResponse = Schema.Struct({
  access: Schema.NullOr(
    Schema.Struct({
      startsAt: Schema.optional(Schema.NullOr(Schema.String)),
      endsAt: Schema.optional(Schema.NullOr(Schema.String)),
      meters: Schema.optional(
        Schema.Struct({
          fiveHour: Schema.optional(GoMeter),
          week: Schema.optional(GoMeter),
          month: Schema.optional(GoMeter),
        }),
      ),
    }),
  ),
});

const DEFAULT_CONSOLE = "https://opencode.ai/console";
const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

/** Session, weekly, and monthly rows, labeled like Codex and Claude. */
function goWindow(
  id: "go_rolling" | "go_weekly" | "go_monthly",
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  usedPercent: number,
  options?: {
    readonly resetsAt?: string | undefined;
    readonly windowDurationMins?: number | undefined;
  },
): ServerProviderUsageWindow {
  return {
    id,
    kind,
    label,
    usedPercent: clampPercent(usedPercent),
    ...(options?.windowDurationMins !== undefined
      ? { windowDurationMins: options.windowDurationMins }
      : {}),
    ...(options?.resetsAt ? { resetsAt: options.resetsAt } : {}),
  };
}

function isoTimestamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function minutesBetween(
  start: string | null | undefined,
  end: string | null | undefined,
): number | undefined {
  if (!start || !end) return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const mins = Math.round(ms / 60_000);
  return mins > 0 ? mins : undefined;
}

function meterPercent(meter: typeof GoMeter.Type): number | null {
  const used = Number(meter.usedMicroCents);
  const limit = Number(meter.limitMicroCents);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return clampPercent((used / limit) * 100);
}

/** Console `go/status` meters, in micro-cents, mapped onto the same window ids as the Go API. */
export function consoleGoStatusToLimits(
  body: typeof GoStatusResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const meters = body.access?.meters;
  if (!meters) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  const windows: ServerProviderUsageWindow[] = [];
  if (meters.fiveHour) {
    const usedPercent = meterPercent(meters.fiveHour);
    if (usedPercent !== null) {
      windows.push(
        goWindow("go_rolling", "session", "Session", usedPercent, {
          windowDurationMins: SESSION_MINS,
          resetsAt: isoTimestamp(meters.fiveHour.resetsAt),
        }),
      );
    }
  }
  if (meters.week) {
    const usedPercent = meterPercent(meters.week);
    if (usedPercent !== null) {
      windows.push(
        goWindow("go_weekly", "weekly", "Weekly", usedPercent, {
          windowDurationMins: WEEK_MINS,
          resetsAt: isoTimestamp(meters.week.resetsAt),
        }),
      );
    }
  }
  if (meters.month) {
    const usedPercent = meterPercent(meters.month);
    if (usedPercent !== null) {
      const resetsAt = isoTimestamp(meters.month.resetsAt ?? body.access?.endsAt);
      windows.push(
        goWindow("go_monthly", "monthly", "Monthly", usedPercent, {
          resetsAt,
          windowDurationMins: minutesBetween(body.access?.startsAt, resetsAt),
        }),
      );
    }
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

function consoleBase(server: string | undefined): string | null {
  const raw = (server?.trim() || DEFAULT_CONSOLE).replace(/\/+$/, "");
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

class OpenCodeConsoleCredentialReadError extends Schema.TaggedError<OpenCodeConsoleCredentialReadError>()(
  "OpenCodeConsoleCredentialReadError",
  { cause: Schema.Defect() },
) {}

/** OpenCode 2 stores the Console sign-in in `opencode.db`, not `auth.json`. */
function readConsoleCredential(dbPath: string) {
  return Effect.try({
    try: () => {
      const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db
          .prepare(
            `SELECT value FROM credential
             WHERE integration_id = 'opencode' AND active = 1
             ORDER BY time_updated DESC
             LIMIT 1`,
          )
          .get() as { readonly value?: string } | undefined;
        return typeof row?.value === "string" ? row.value : null;
      } finally {
        db.close();
      }
    },
    catch: (cause) => new OpenCodeConsoleCredentialReadError({ cause }),
  }).pipe(
    Effect.catch((error) => {
      const message = error.cause instanceof Error ? error.cause.message : String(error.cause);
      return /SQLITE_CANTOPEN|unable to open database|ENOENT|no such file/i.test(message)
        ? Effect.succeed(null)
        : Effect.fail(error);
    }),
  );
}

// Select before decoding so an OAuth or self-hosted connection cannot fall
// through to another stored account. NULL-active rows predate the selection flag.
class OpenCodeCredentialReadError extends Schema.TaggedError<OpenCodeCredentialReadError>()(
  "OpenCodeCredentialReadError",
  { databasePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read OpenCode credentials from ${this.databasePath}.`;
  }
}

const readStoredApiKey = (databasePath: string, integrationId: "opencode" | "opencode-go") =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const row = database
          .prepare(
            `SELECT value FROM credential
             WHERE integration_id = ? AND active IS NOT 0
             ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`,
          )
          .get(integrationId);
        const stored =
          typeof row?.value === "string"
            ? Option.getOrUndefined(decodeStoredKey(row.value))
            : undefined;
        const server = stored?.metadata?.server;
        if (typeof server === "string") {
          const url = new URL(server);
          if (`${url.origin}${url.pathname.replace(/\/+$/, "")}` !== "https://opencode.ai/console")
            return undefined;
        }
        return stored?.key.trim();
      } finally {
        database.close();
      }
    },
    catch: (cause) => new OpenCodeCredentialReadError({ databasePath, cause }),
  }).pipe(Effect.orElseSucceed(() => undefined));

/** External OpenCode servers own their credentials; never read the host's account for them. */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled || input.serverUrl.trim()) return unsupported;

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.environment;
    const dataHome =
      env.XDG_DATA_HOME ||
      path.join(
        env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory),
        ".local",
        "share",
      );
    const authPath = path.join(dataHome, "opencode", "auth.json");
    const contents =
      env.OPENCODE_AUTH_CONTENT ||
      (yield* fs.readFileString(authPath).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
        }),
      ));
    const auth = yield* decodeAuthFile(contents);
    const apiAuth = decodeApiAuth(auth["opencode-go"]);
    // OpenCode overlays stored API credentials after environment credentials.
    const goKey = (Option.isSome(apiAuth) ? apiAuth.value.key : env.OPENCODE_API_KEY)?.trim();
    // Console supplies Go credentials in OpenCode 2. Inline auth explicitly
    // overrides local credentials, including the Console connection.
    const databaseFile = env.OPENCODE_DB ?? "opencode.db";
    const databasePath = path.resolve(dataHome, "opencode", databaseFile);
    const storedKeys =
      env.OPENCODE_AUTH_CONTENT || databaseFile === ":memory:"
        ? []
        : [
            yield* readStoredApiKey(databasePath, "opencode"),
            // OpenCode 2 imports auth.json once, so a replaced Go key only exists here.
            yield* readStoredApiKey(databasePath, "opencode-go"),
          ];
    const keys = [...new Set([...storedKeys, goKey].filter((key): key is string => Boolean(key)))];
    let apiKey = keys[0];
    const client = yield* HttpClient.HttpClient;
    if (!apiKey) {
      // Without a Go key, a Console sign-in still reports Go limits. Inline auth
      // overrides local credentials, so it skips the Console too.
      if (env.OPENCODE_AUTH_CONTENT || databaseFile === ":memory:") return unsupported;
      const stored = yield* readConsoleCredential(databasePath);
      const credential = stored === null ? Option.none() : decodeConsoleCredential(stored);
      if (Option.isNone(credential)) return unsupported;
      const token = (
        credential.value.type === "oauth" ? credential.value.access : credential.value.key
      ).trim();
      const orgId = credential.value.metadata?.orgID?.trim();
      const base = consoleBase(credential.value.metadata?.server);
      if (!token || !orgId || !base) return unsupported;

      const response = yield* client.execute(
        HttpClientRequest.get(`${base}/api/go/status`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeaders({ "x-org-id": orgId }),
        ),
      );
      if (response.status === 401) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "OpenCode Console needs to be signed in again.",
        });
      }
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(GoStatusResponse)),
      );
      const limits = consoleGoStatusToLimits(body, checkedAt);
      const digest = yield* Digest.Digest;
      const credentialFingerprint = yield* digest
        .digest(Digest.sha256, new TextEncoder().encode(`opencode-console\0${base}\0${orgId}`))
        .pipe(Effect.map(Hex.encode), Effect.orDie);
      return { ...limits, credentialFingerprint };
    }

    const readUsage = (key: string) =>
      client.execute(
        HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
          HttpClientRequest.bearerToken(key),
        ),
      );
    let response = yield* readUsage(apiKey);
    for (const key of keys.slice(1)) {
      if (response.status !== 401 && response.status !== 403) break;
      apiKey = key;
      response = yield* readUsage(apiKey);
    }
    // A valid Zen key can exist without a Go subscription.
    if (response.status === 403) return unsupported;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
    );
    const windows: ServerProviderUsageWindow[] = [
      {
        id: "go_rolling",
        kind: "session",
        label: "Go · Session",
        windowDurationMins: 5 * 60,
        usedPercent: clampPercent(body.usage.rolling.percent),
        resetsAt: DateTime.formatIso(body.usage.rolling.resetsAt),
      },
      {
        id: "go_weekly",
        kind: "weekly",
        label: "Go · Weekly",
        windowDurationMins: 7 * 24 * 60,
        usedPercent: clampPercent(body.usage.weekly.percent),
        resetsAt: DateTime.formatIso(body.usage.weekly.resetsAt),
      },
      {
        id: "go_monthly",
        kind: "monthly",
        label: "Go · Monthly",
        usedPercent: clampPercent(body.usage.monthly.percent),
        resetsAt: DateTime.formatIso(body.usage.monthly.resetsAt),
      },
    ];
    const digest = yield* Digest.Digest;
    // Unkeyed hashes match across environments; random Go keys resist offline guessing.
    const credentialFingerprint = yield* digest
      .digest(Digest.sha256, new TextEncoder().encode(`opencode-go\0${apiKey}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      credentialFingerprint,
    };
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode Go could not read usage.",
      }),
    ),
  );
});
