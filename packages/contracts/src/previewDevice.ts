import { Schema } from "effect";

// Optional metadata lets existing hosts retain their dimensions-only behavior.
export const Orientation = Schema.Literals(["portrait", "landscape"]);
export const TextScale = Schema.Literals([1, 1.25, 1.5]);
export const TestFields = {
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
