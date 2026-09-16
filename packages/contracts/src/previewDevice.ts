import { Schema } from "effect";
import { PreviewTabId } from "./preview.ts";

// Optional metadata lets existing hosts retain their dimensions-only behavior.
const Orientation = Schema.Literals(["portrait", "landscape"]);
const TextScale = Schema.Literals([1, 1.25, 1.5]);
const TestFields = {
  keyboard: Schema.Boolean,
  toolbar: Schema.Literals(["off", "expanded", "collapsed"]),
  safeAreas: Schema.Boolean,
  connection: Schema.Literals(["normal", "slow", "offline"]),
  textScale: TextScale,
  reducedMotion: Schema.Boolean,
};
export const PreviewDeviceTests = Schema.Struct(TestFields);
const Choice = Schema.Struct({
  mode: Schema.Literals(["profile", "mobile", "desktop"]),
  orientation: Orientation,
  tests: Schema.optional(PreviewDeviceTests),
});
export const PreviewDeviceViewport = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("fill"), device: Schema.optional(Choice) }),
  Schema.Struct({
    mode: Schema.Literal("preset"),
    preset: Schema.String,
    label: Schema.String,
    width: Schema.Finite,
    height: Schema.Finite,
    device: Schema.optional(Choice),
  }),
  Schema.Struct({
    mode: Schema.Literal("freeform"),
    width: Schema.Finite,
    height: Schema.Finite,
    device: Schema.optional(Choice),
  }),
]);
const Configuration = Schema.Struct({
  mobile: Schema.Boolean,
  touch: Schema.Boolean,
  density: Schema.Finite,
  identity: Schema.Literals(["android", "desktop"]),
  profileId: Schema.NullOr(Schema.String),
  orientation: Orientation,
  tests: PreviewDeviceTests,
});
export const PreviewDeviceState = Schema.Struct({
  applied: Configuration,
  pending: Schema.optional(PreviewDeviceViewport),
  suspended: Schema.optional(Schema.String),
});
export const PreviewDeviceSnapshot = Schema.Struct({
  viewport: PreviewDeviceViewport,
  applied: Configuration,
  chromium: Schema.String,
  electron: Schema.String,
  layout: Schema.Struct({ width: Schema.Finite, height: Schema.Finite }),
  visual: Schema.Struct({
    width: Schema.Finite,
    height: Schema.Finite,
    scale: Schema.Finite,
    offsetLeft: Schema.Finite,
    offsetTop: Schema.Finite,
  }),
  geometry: Schema.Struct({
    keyboardHeight: Schema.Finite,
    toolbarHeight: Schema.Finite,
    usableHeight: Schema.Finite,
    smallViewportDifference: Schema.Finite,
    insets: Schema.Struct({
      top: Schema.Finite,
      right: Schema.Finite,
      bottom: Schema.Finite,
      left: Schema.Finite,
    }),
  }),
  density: Schema.Finite,
  outputScale: Schema.Finite,
  suspended: Schema.optional(Schema.String),
});
export const PreviewDeviceResultFields = {
  device: Schema.optional(PreviewDeviceState),
  deviceSnapshot: Schema.optional(PreviewDeviceSnapshot),
};
export const PreviewDeviceEvidenceFields = {
  device: Schema.optional(PreviewDeviceSnapshot),
  deviceChanges: Schema.optional(
    Schema.Array(Schema.Struct({ atMs: Schema.Finite, device: PreviewDeviceSnapshot })),
  ),
  notice: Schema.optional(Schema.String),
};
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
const Target = {
  tabId: Schema.optional(PreviewTabId).annotate({
    description: "Exact browser tab. Omit for the current agent tab.",
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(60000)),
  ).annotate({ description: "Operation deadline in milliseconds, maximum 60000." }),
};
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
