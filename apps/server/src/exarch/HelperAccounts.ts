import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";

/**
 * Which account a helper runs on, read from each account's live usage. The
 * owner's helper table chooses a model, not an account, so a helper may start
 * on any visible account offering that model: never on one that is out of
 * usage, and preferably on the one with the most room left.
 */

const words = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);

/** Shared windows always bind; Claude's per-model weekly window ("Weekly · Opus") binds only that model. */
function windowsFor(
  provider: ServerProvider,
  model: string,
): ReadonlyArray<ServerProviderUsageWindow> {
  const modelWords = words(model);
  return (provider.usageLimits?.windows ?? []).filter((window) => {
    const scoped =
      provider.driver === "claudeAgent" &&
      window.id.startsWith("seven_day_") &&
      window.label.startsWith("Weekly · ");
    return (
      !scoped ||
      words(window.label.slice("Weekly · ".length)).every((word) => modelWords.includes(word))
    );
  });
}

/** Why this account cannot take a helper on this model right now because of its usage, or null. */
export function helperUsageLimitReason(
  provider: ServerProvider,
  model: string,
  nowMs: number,
): string | null {
  const spent = windowsFor(provider, model).filter(
    (window) =>
      window.usedPercent >= 100 && (!window.resetsAt || Date.parse(window.resetsAt) > nowMs),
  );
  if (spent.length === 0) return null;
  const until = spent.every((window) => window.resetsAt)
    ? spent
        .map((window) => window.resetsAt!)
        .sort()
        .at(-1)
    : undefined;
  return until
    ? `Account '${provider.instanceId}' is out of usage until ${until}.`
    : `Account '${provider.instanceId}' is out of usage.`;
}

/** The highest share of any binding window used, 0 for an account without plan limits, null when unknown. */
function pressure(provider: ServerProvider, model: string): number | null {
  if (provider.usageLimits?.unavailable?.reason === "unsupported") return 0;
  const windows = windowsFor(provider, model);
  return windows.length === 0 ? null : Math.max(...windows.map((window) => window.usedPercent));
}

/**
 * Among candidates offering the chosen model on the same driver, the one with
 * the most usage left. Accounts with known usage rank ahead of unknown ones;
 * ties keep the owner's visible order.
 */
export function roomiestHelperAccount<
  T extends { readonly selection: { readonly model: string }; readonly provider: ServerProvider },
>(chosen: T, candidates: ReadonlyArray<T>): T {
  const rank = (candidate: T) => pressure(candidate.provider, candidate.selection.model) ?? 101;
  return candidates
    .filter(
      (candidate) =>
        candidate.selection.model === chosen.selection.model &&
        candidate.provider.driver === chosen.provider.driver,
    )
    .reduce((best, candidate) => (rank(candidate) < rank(best) ? candidate : best), chosen);
}
