import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ServerSettingsService } from "../serverSettings.ts";
import { memoryCards } from "./TaskProgress.testkit.ts";
import {
  layer,
  makeTaskProgress,
  TaskProgress,
  type TaskProgressShape,
} from "./TaskProgressRuntime.ts";

const threadId = ThreadId.make("chat-1");

describe("task progress service", () => {
  it.effect(
    "refuses until the orchestrator binds its commands, and again once its scope ends",
    () =>
      Effect.gen(function* () {
        const service = yield* makeTaskProgress(Effect.succeed(true));
        const before = yield* service.publish(threadId, { markdown: "Early" }).pipe(Effect.flip);
        assert.equal(before.detail, "Task progress is not available on this engine.");
        const scope = yield* Scope.make();
        yield* service.bind(memoryCards().commands).pipe(Scope.provide(scope));
        assert.deepEqual(yield* service.publish(threadId, { markdown: "Bound" }), {
          message: "Progress card updated (rev 1)",
          revision: 1,
          steps: null,
        });
        assert.equal((yield* service.read(threadId))?.markdown, "Bound");
        yield* Scope.close(scope, Exit.void);
        yield* service.read(threadId).pipe(Effect.flip);
      }),
  );

  it.effect("acknowledges from the write's own record, not a later read", () =>
    Effect.gen(function* () {
      const service = yield* makeTaskProgress(Effect.succeed(true));
      const cards = memoryCards();
      yield* service.bind({
        ...cards.commands,
        // Another writer lands between this write and any read.
        write: (id, content) =>
          cards.commands
            .write(id, content)
            .pipe(Effect.tap(() => cards.commands.write(id, { markdown: "Someone else" }))),
      });
      assert.deepEqual(
        yield* service.publish(threadId, { plan: [{ step: "Mine", status: "in_progress" }] }),
        {
          message: "Progress card updated (rev 1, 0/1 done)",
          revision: 1,
          steps: { completed: 0, total: 1 },
        },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("closes the MCP writer while any claim on the chat is held, releasing each once", () =>
    Effect.gen(function* () {
      const service = yield* makeTaskProgress(Effect.succeed(true));
      const first = service.claimWriter(threadId);
      const second = service.claimWriter(threadId);
      first();
      first();
      assert.isTrue(service.claimed(threadId));
      second();
      assert.isFalse(service.claimed(threadId));
    }),
  );

  it.effect("refuses everything and reports disabled without the live layer", () =>
    Effect.gen(function* () {
      const service = yield* TaskProgress;
      assert.isFalse(yield* service.enabled);
      yield* service.publish(threadId, {}).pipe(Effect.flip);
    }),
  );

  it.effect("gives every consumer that provides the layer one service", () =>
    Effect.gen(function* () {
      // Adapters are built inside the provider registry's Layer.unwrap; the
      // orchestrator and the MCP toolkit provide the layer directly.
      class Direct extends Context.Service<Direct, TaskProgressShape>()(
        "t3/exarch/TaskProgressRuntime.test/Direct",
      ) {}
      class Unwrapped extends Context.Service<Unwrapped, TaskProgressShape>()(
        "t3/exarch/TaskProgressRuntime.test/Unwrapped",
      ) {}
      const direct = Layer.effect(Direct, Effect.service(TaskProgress)).pipe(Layer.provide(layer));
      const unwrapped = Layer.unwrap(
        Effect.succeed(
          Layer.effect(Unwrapped, Effect.service(TaskProgress)).pipe(Layer.provide(layer)),
        ),
      );
      const [a, b] = yield* Effect.all([Effect.service(Direct), Effect.service(Unwrapped)]).pipe(
        Effect.provide(
          Layer.mergeAll(direct, unwrapped).pipe(Layer.provide(ServerSettingsService.layerTest())),
        ),
      );
      assert.strictEqual(a, b);
    }),
  );
});
