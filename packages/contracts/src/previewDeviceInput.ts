import { Schema } from "effect";
import { OptionalTimeoutMs, PreviewAutomationTabTargetFields } from "./previewAutomation.ts";
import { Orientation, TestFields, TextScale } from "./previewDevice.ts";

/** Inputs for the device tools. They live apart from the device model, which previewAutomation imports. */
const Dimension = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(240),
  Schema.isLessThanOrEqualTo(3840),
);
const ViewportRequest = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("fill") }),
  Schema.Struct({
    mode: Schema.Literal("preset"),
    preset: Schema.String,
    orientation: Schema.optional(Orientation),
  }),
  Schema.Struct({
    mode: Schema.Literal("freeform"),
    width: Dimension,
    height: Dimension,
    deviceMode: Schema.optional(Schema.Literals(["mobile", "desktop"])),
    orientation: Schema.optional(Orientation),
  }),
]);
const Target = { ...PreviewAutomationTabTargetFields, timeoutMs: OptionalTimeoutMs };
export const PreviewAutomationEmulateInput = Schema.Struct({
  ...Target,
  viewport: Schema.optional(ViewportRequest).annotate({
    description: "Profile or custom Chromium device; fill resets all overrides.",
  }),
  tests: Schema.optional(
    Schema.Struct({
      keyboard: Schema.optional(TestFields.keyboard),
      toolbar: Schema.optional(TestFields.toolbar),
      safeAreas: Schema.optional(TestFields.safeAreas),
      connection: Schema.optional(TestFields.connection),
      textScale: Schema.optional(TextScale),
      reducedMotion: Schema.optional(TestFields.reducedMotion),
    }),
  ).annotate({
    description: "Per-tab test choices. Supplied fields replace their previous values.",
  }),
  resetTests: Schema.optional(Schema.Boolean).annotate({
    description: "Clear testing conditions while preserving the selected device.",
  }),
  reload: Schema.optional(Schema.Boolean).annotate({
    description: "Explicitly reload to apply pending identity changes. This discards page state.",
  }),
});
const Coordinate = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(100000),
);
export const PreviewAutomationGestureInput = Schema.Struct({
  ...Target,
  kind: Schema.Literals(["tap", "double-tap", "long-press", "swipe", "pinch"]).annotate({
    description: "Native touch gesture to deliver.",
  }),
  x: Coordinate.annotate({ description: "Viewport X coordinate in CSS pixels." }),
  y: Coordinate.annotate({ description: "Viewport Y coordinate in CSS pixels." }),
  end: Schema.optional(Schema.Struct({ x: Coordinate, y: Coordinate })).annotate({
    description: "Swipe end in viewport CSS pixels.",
  }),
  scale: Schema.optional(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0.25), Schema.isLessThanOrEqualTo(4)),
  ).annotate({ description: "Pinch scale multiplier, from 0.25 through 4." }),
  durationMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(5000)),
  ).annotate({ description: "Gesture duration in milliseconds, maximum 5000." }),
}).check(
  Schema.makeFilter((input) =>
    input.kind === "swipe" && !input.end
      ? "A swipe requires end coordinates."
      : input.kind === "pinch" && input.scale === undefined
        ? "A pinch requires a scale."
        : true,
  ),
);
