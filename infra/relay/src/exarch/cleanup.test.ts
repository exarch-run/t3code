import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import * as AgentActivityRows from "../agentActivity/AgentActivityRows.ts";
import * as DeliveryAttempts from "../agentActivity/DeliveryAttempts.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayDb from "../db.ts";
import * as Cleanup from "./cleanup.ts";

describe("expiry cleanup", () => {
  it.effect("a failed category is logged and the others still run", () => {
    const ran: Array<string> = [];
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(message);
    });
    const fakeDb = {
      update: () => ({
        set: () => ({ where: () => Effect.sync(() => void ran.push("live-activities")) }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Cleanup.pruneExpiredState.pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(ran).toEqual(["agent-activity", "live-activities", "delivery-attempts"]);
          expect(warnings).toHaveLength(1);
          expect(JSON.stringify(warnings[0])).toContain("Failed to prune expired DPoP proofs");
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DpopProofs.DpopProofReplay, {
            pruneExpired: Effect.fail(
              new DpopProofs.DpopProofReplayPersistenceError({
                operation: "prune-expired",
                cause: new Error("database unavailable"),
              }),
            ),
          } as unknown as DpopProofs.DpopProofReplay["Service"]),
          Layer.succeed(AgentActivityRows.AgentActivityRows, {
            pruneExpired: Effect.sync(() => void ran.push("agent-activity")),
          } as unknown as AgentActivityRows.AgentActivityRows["Service"]),
          Layer.succeed(DeliveryAttempts.DeliveryAttempts, {
            pruneExpired: Effect.sync(() => void ran.push("delivery-attempts")),
          } as unknown as DeliveryAttempts.DeliveryAttempts["Service"]),
          Layer.succeed(RelayDb.RelayDb, fakeDb),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });
});
