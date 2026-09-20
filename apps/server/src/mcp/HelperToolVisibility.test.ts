import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpBody, HttpServerResponse } from "effect/unstable/http";
import { hideHelperTool } from "./HelperToolVisibility.ts";
const response = {
  jsonrpc: "2.0",
  id: 2,
  result: { tools: [{ name: "delegate_task" }, { name: "t3_thread_read" }] },
};
it("hides only delegation in a JSON tools list", () => {
  const filtered = hideHelperTool(HttpServerResponse.jsonUnsafe(response));
  assert.equal(filtered.body._tag, "Uint8Array");
  if (filtered.body._tag !== "Uint8Array") return;
  const parsed = JSON.parse(new TextDecoder().decode(filtered.body.body));
  assert.deepEqual(parsed.result.tools, [{ name: "t3_thread_read" }]);
});
const wire = `event: message\ndata: ${JSON.stringify(response)}\n\n`;
it.effect("preserves SSE framing across split transport chunks", () =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode(wire);
    const filtered = hideHelperTool(
      HttpServerResponse.empty().pipe(
        HttpServerResponse.setBody(
          HttpBody.stream(Stream.make(bytes.slice(0, 45), bytes.slice(45)), "text/event-stream"),
        ),
      ),
    );
    assert.equal(filtered.body._tag, "Stream");
    if (filtered.body._tag !== "Stream") return;
    const chunks = yield* filtered.body.stream.pipe(
      Stream.decodeText,
      Stream.runCollect,
      Effect.orDie,
    );
    const text = chunks.join("");
    assert.include(text, "event: message\ndata: ");
    assert.include(text, "t3_thread_read");
    assert.notInclude(text, "delegate_task");
    assert.isTrue(text.endsWith("\n\n"));
  }),
);
