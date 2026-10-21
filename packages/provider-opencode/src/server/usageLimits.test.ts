// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";

import { consoleGoStatusToLimits, readOpenCodeGoUsageLimits } from "./usageLimits.ts";

it("maps Console meters to session, weekly, and monthly usage windows", () => {
  const limits = consoleGoStatusToLimits(
    {
      access: {
        startsAt: "2026-10-05T10:53:14.000Z",
        endsAt: "2026-11-05T10:53:14.000Z",
        meters: {
          fiveHour: {
            limitMicroCents: "1200000000",
            usedMicroCents: "1800000000",
            resetsAt: null,
          },
          week: {
            limitMicroCents: 300,
            usedMicroCents: 150,
            resetsAt: "2026-10-19T00:00:00.000Z",
          },
          month: { limitMicroCents: "600", usedMicroCents: "60" },
        },
      },
    },
    "2026-10-17T00:00:00.000Z",
  );

  NodeAssert.deepEqual(
    limits.windows.map(({ id, kind, label, usedPercent, resetsAt, windowDurationMins }) => ({
      id,
      kind,
      label,
      usedPercent,
      resetsAt: resetsAt ?? null,
      windowDurationMins: windowDurationMins ?? null,
    })),
    [
      {
        id: "go_rolling",
        kind: "session",
        label: "Session",
        usedPercent: 100,
        resetsAt: null,
        windowDurationMins: 300,
      },
      {
        id: "go_weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 50,
        resetsAt: "2026-10-19T00:00:00.000Z",
        windowDurationMins: 10080,
      },
      {
        id: "go_monthly",
        kind: "monthly",
        label: "Monthly",
        usedPercent: 10,
        resetsAt: "2026-11-05T10:53:14.000Z",
        windowDurationMins: 31 * 24 * 60,
      },
    ],
  );
});

it("marks absent Console Go access as unsupported", () => {
  const limits = consoleGoStatusToLimits({ access: null }, "2026-10-17T00:00:00.000Z");
  NodeAssert.equal(limits.unavailable?.reason, "unsupported");
  NodeAssert.deepEqual(limits.windows, []);
});

const makeConsoleDb = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode-console-limits-"));
  const dataDir = NodePath.join(root, "opencode");
  NodeFS.mkdirSync(dataDir);
  const db = new NodeSqlite.DatabaseSync(NodePath.join(dataDir, "opencode.db"));
  db.exec(
    `CREATE TABLE credential (
      id text primary key,
      integration_id text,
      value text not null,
      active integer,
      time_updated integer not null
    )`,
  );
  const insert = db.prepare(
    `INSERT INTO credential (id, integration_id, value, active, time_updated) VALUES (?, 'opencode', ?, ?, ?)`,
  );
  insert.run(
    "stale",
    JSON.stringify({ type: "key", key: "stale-key", metadata: { orgID: "org_stale" } }),
    0,
    1,
  );
  insert.run(
    "active",
    JSON.stringify({
      type: "oauth",
      access: "console-secret",
      metadata: { server: "https://opencode.ai/console", orgID: "org_test" },
    }),
    1,
    2,
  );
  db.close();
  return { root, dataHome: root };
};

it.effect(
  "reads the active Console credential, requests Go status, and fingerprints host plus org",
  () =>
    Effect.gen(function* () {
      const { root, dataHome } = makeConsoleDb();
      yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.rmSync(root, { recursive: true })));
      const limits = yield* readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: { XDG_DATA_HOME: dataHome },
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ readFileString: () => Effect.succeed("{}") }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            NodeAssert.equal(request.url, "https://opencode.ai/console/api/go/status");
            NodeAssert.equal(request.headers.authorization, "Bearer console-secret");
            NodeAssert.equal(request.headers["x-org-id"], "org_test");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  access: {
                    startsAt: "2026-10-05T10:53:14.000Z",
                    endsAt: "2026-11-05T10:53:14.000Z",
                    meters: {
                      fiveHour: {
                        limitMicroCents: "1200000000",
                        usedMicroCents: "600000000",
                      },
                    },
                  },
                }),
              ),
            );
          }),
        ),
        Effect.provide(NodeServices.layer),
      );

      const expectedFingerprint = NodeCrypto.createHash("sha256")
        .update("opencode-console\0https://opencode.ai/console\0org_test")
        .digest("hex");
      NodeAssert.equal(limits.credentialFingerprint, expectedFingerprint);
      NodeAssert.notEqual(limits.credentialFingerprint, "console-secret");
      NodeAssert.equal(limits.windows[0]?.usedPercent, 50);
    }),
);

it.effect("skips Go usage when the server setting turns limits off", () =>
  Effect.gen(function* () {
    const limits = yield* readOpenCodeGoUsageLimits({
      enabled: true,
      usageLimitsEnabled: false,
      serverUrl: "",
      environment: {},
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.die("auth should not be read when limits are off"),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("usage should not be fetched when limits are off")),
      ),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.equal(limits.unavailable?.reason, "unsupported");
    NodeAssert.deepEqual(limits.windows, []);
  }),
);

it.effect("reports a signed-out Console response as a failed probe", () =>
  Effect.gen(function* () {
    const { root, dataHome } = makeConsoleDb();
    yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.rmSync(root, { recursive: true })));
    const limits = yield* readOpenCodeGoUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: { XDG_DATA_HOME: dataHome },
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ readFileString: () => Effect.succeed("{}") }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 401 }))),
        ),
      ),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.equal(limits.unavailable?.reason, "probeFailed");
    NodeAssert.deepEqual(limits.windows, []);
    NodeAssert.equal((limits.unavailable?.message ?? "").includes("console-secret"), false);
  }),
);
