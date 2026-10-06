import {
  TrimmedNonEmptyString,
  ServerProviderCompatibilityStatus,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };

// Deliberately uses the shared CLI gate syntax: comparator groups joined by ||.
// Prereleases and unrecognized release tags remain unknown.
const StableVersion = TrimmedNonEmptyString.pipe(
  Schema.check(Schema.makeFilter((value) => /^\d+\.\d+\.\d+$/.test(value))),
);
const VersionRange = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      value.split("||").every((group) => {
        const tokens = group.trim().split(/\s+/);
        return tokens.every((token) => /^(?:\^|>=|>|<=|<|=)?v?\d+(?:\.\d+){0,2}$/.test(token));
      }),
    ),
  ),
);
const Policy = Schema.Struct({
  driver: TrimmedNonEmptyString,
  t3CodeRange: VersionRange,
  recommendedRange: Schema.optionalKey(VersionRange),
  recommendedVersion: Schema.optionalKey(StableVersion),
  ranges: Schema.Array(
    Schema.Struct({
      range: VersionRange,
      status: ServerProviderCompatibilityStatus,
    }),
  ),
});

export const ProviderCompatibilityPolicy = Policy.pipe(
  Schema.check(
    Schema.makeFilter(
      (policy) => {
        const version = policy.recommendedVersion;
        if (version === undefined) return true;
        return (
          (policy.recommendedRange === undefined ||
            satisfiesSemverRange(version, policy.recommendedRange)) &&
          policy.ranges.find((entry) => satisfiesSemverRange(version, entry.range))?.status ===
            "supported"
        );
      },
      { expected: "a recommended version in a supported range" },
    ),
  ),
);
export type ProviderCompatibilityPolicy = typeof ProviderCompatibilityPolicy.Type;

/**
 * This fork keeps Orchestrator V1 and speaks OpenCode 2 from 2.0.18 up.
 * Upstream's remote manifest marks every 2.x release broken for T3 Code
 * before 0.0.46. Replace that matching policy so a refresh cannot hide a
 * server this build can actually drive. OpenCode 1.14.19–1.x stays on the
 * legacy client. 2.0.0–2.0.17 stays unsupported.
 */
const FORK_OPENCODE_V1_T3_RANGE = ">=0.0.42 <0.0.46";
const forkOpenCodeV1Policy: ProviderCompatibilityPolicy = {
  driver: "opencode",
  t3CodeRange: FORK_OPENCODE_V1_T3_RANGE,
  recommendedRange: ">=1.14.19 <2.0.0 || >=2.0.18",
  ranges: [
    { range: ">=2.0.18", status: "supported" },
    { range: ">=2.0.0 <2.0.18", status: "unsupported" },
    { range: ">=1.14.19 <2.0.0", status: "supported" },
    { range: "<1.14.19", status: "broken" },
  ],
};

function openCode2Status(
  policy: ProviderCompatibilityPolicy,
): ProviderCompatibilityPolicy["ranges"][number]["status"] | undefined {
  return policy.ranges.find((entry) => satisfiesSemverRange("2.0.23", entry.range))?.status;
}

function policiesForResolution(
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  driver: ProviderDriverKind,
  t3CodeVersion: string,
): ReadonlyArray<ProviderCompatibilityPolicy> | undefined {
  if (
    policies === undefined ||
    driver !== "opencode" ||
    !satisfiesSemverRange(t3CodeVersion, FORK_OPENCODE_V1_T3_RANGE)
  ) {
    return policies;
  }
  return policies.map((policy) => {
    if (policy.driver !== "opencode" || !satisfiesSemverRange(t3CodeVersion, policy.t3CodeRange)) {
      return policy;
    }
    // Only the upstream "OpenCode 2 is broken on V1" policy is rewritten.
    // A policy that already supports 2.0.23 is left alone.
    return openCode2Status(policy) === "broken" ? forkOpenCodeV1Policy : policy;
  });
}

export function resolveProviderCompatibility(
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  driver: ProviderDriverKind,
  version: string | null,
  t3CodeVersion = packageJson.version,
): ServerProviderCompatibilityAdvisory | undefined {
  const resolvedPolicies = policiesForResolution(policies, driver, t3CodeVersion);
  const policy = resolvedPolicies?.find(
    (entry) => entry.driver === driver && satisfiesSemverRange(t3CodeVersion, entry.t3CodeRange),
  );
  if (!policy) return undefined;
  const unprefixed = version?.replace(/^v/, "");
  // Cursor appends a build hash to its date; Google's ACP runtime uses a release prefix.
  // Strip only these driver-specific forms, keeping semver prereleases unknown.
  const stable =
    driver === "cursor"
      ? unprefixed?.replace(/^(\d{4}\.\d{2}\.\d{2})-[a-f0-9]+$/, "$1")
      : driver === "antigravity"
        ? unprefixed?.replace(/^agy_acp_server_(\d+\.\d+\.\d+)$/, "$1")
        : unprefixed;
  const status =
    stable && /^\d+\.\d+\.\d+$/.test(stable)
      ? (policy.ranges.find((entry) => satisfiesSemverRange(stable, entry.range))?.status ??
        "unknown")
      : "unknown";
  const message =
    status === "broken"
      ? "This provider version is known to be incompatible with this T3 Code release."
      : status === "unsupported"
        ? "This provider version is outside the supported range for this T3 Code release."
        : status === "graceful"
          ? "This provider version has limited compatibility with this T3 Code release."
          : null;
  const recommendedVersion = policy.recommendedVersion ?? null;
  const recommendedRange = policy.recommendedRange ?? null;
  const recommendation = recommendedVersion ?? recommendedRange;
  return {
    status,
    message: message && recommendation ? `${message} Use ${recommendation}.` : message,
    recommendedVersion,
    recommendedRange,
  };
}

/** A remote policy replaces its matching bundled policy; omission keeps the bundle. */
export function applyProviderCompatibility(
  snapshot: ServerProvider,
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  fallback: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
): ServerProvider {
  const { compatibilityAdvisory: _previous, ...base } = snapshot;
  if (!snapshot.enabled || !snapshot.installed) return base;
  const advisory =
    resolveProviderCompatibility(policies, snapshot.driver, snapshot.version) ??
    resolveProviderCompatibility(fallback, snapshot.driver, snapshot.version);
  const latestVersion = snapshot.versionAdvisory?.latestVersion;
  const latestAdvisory = latestVersion
    ? (resolveProviderCompatibility(policies, snapshot.driver, latestVersion) ??
      resolveProviderCompatibility(fallback, snapshot.driver, latestVersion))
    : undefined;
  return advisory
    ? {
        ...base,
        compatibilityAdvisory: {
          ...advisory,
          ...(latestAdvisory ? { latestVersionStatus: latestAdvisory.status } : {}),
        },
      }
    : base;
}
