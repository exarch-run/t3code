import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import * as AgentActivityRows from "../agentActivity/AgentActivityRows.ts";
import * as DeliveryAttempts from "../agentActivity/DeliveryAttempts.ts";
import * as LiveActivities from "../agentActivity/LiveActivities.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";

/**
 * Lets a cron job fail without stopping the jobs after it, and leaves a warning
 * behind, since tracing is off and nothing else would record the failure.
 */
export const warnOnFailure =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logWarning(message, { cause }),
      ),
    );

/** Removes expired privacy-sensitive rows. Each category runs even when another fails. */
export const pruneExpiredState = Effect.all(
  [
    DpopProofs.DpopProofReplay.pipe(
      Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
      warnOnFailure("Failed to prune expired DPoP proofs"),
    ),
    AgentActivityRows.AgentActivityRows.pipe(
      Effect.flatMap((rows) => rows.pruneExpired),
      warnOnFailure("Failed to prune expired agent activity"),
    ),
    LiveActivities.pruneExpiredContent.pipe(
      warnOnFailure("Failed to clear expired Live Activity content"),
    ),
    DeliveryAttempts.DeliveryAttempts.pipe(
      Effect.flatMap((attempts) => attempts.pruneExpired),
      warnOnFailure("Failed to prune expired delivery attempts"),
    ),
  ],
  { discard: true },
);
