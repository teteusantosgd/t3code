import * as NodeOS from "node:os";
import { DatabaseSync } from "node:sqlite";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const AuthFile = Schema.Struct({ "opencode-go": Schema.optionalKey(Schema.Unknown) });
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);
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
  options?: { readonly resetsAt?: string; readonly windowDurationMins?: number },
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

/**
 * OpenCode 2 stores the Console sign-in in `opencode.db`, not `auth.json`.
 * The active row is the account `opencode auth list` shows.
 */
function readConsoleCredential(dbPath: string) {
  return Effect.try({
    try: () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
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
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A machine without a Console sign-in has no database yet.
      if (/SQLITE_CANTOPEN|unable to open database|ENOENT|no such file/i.test(message)) {
        return Effect.succeed(null);
      }
      return Effect.fail(cause);
    }),
  );
}

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
      path.join(env.HOME || env.USERPROFILE || NodeOS.homedir(), ".local", "share");
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
    const apiKey = (Option.isSome(apiAuth) ? apiAuth.value.key : env.OPENCODE_API_KEY)?.trim();
    const client = yield* HttpClient.HttpClient;

    if (apiKey) {
      const response = yield* client.execute(
        HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
          HttpClientRequest.bearerToken(apiKey),
        ),
      );
      // A valid Zen key can exist without a Go subscription.
      if (response.status === 403) return unsupported;
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
      );
      return makeUsageLimits({
        checkedAt,
        windows: [
          goWindow("go_rolling", "session", "Session", body.usage.rolling.percent, {
            windowDurationMins: SESSION_MINS,
            resetsAt: DateTime.formatIso(body.usage.rolling.resetsAt),
          }),
          goWindow("go_weekly", "weekly", "Weekly", body.usage.weekly.percent, {
            windowDurationMins: WEEK_MINS,
            resetsAt: DateTime.formatIso(body.usage.weekly.resetsAt),
          }),
          goWindow("go_monthly", "monthly", "Monthly", body.usage.monthly.percent, {
            resetsAt: DateTime.formatIso(body.usage.monthly.resetsAt),
          }),
        ],
      });
    }

    const stored = yield* readConsoleCredential(path.join(dataHome, "opencode", "opencode.db"));
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
    return consoleGoStatusToLimits(body, checkedAt);
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
