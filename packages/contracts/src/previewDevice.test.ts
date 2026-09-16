import { Schema } from "effect";
import { expect, it } from "vite-plus/test";
import {
  PreviewAutomationEmulateInput,
  PreviewAutomationGestureInput,
  PreviewDeviceSnapshot,
} from "./previewDevice.ts";
import {
  PreviewAutomationRecordingArtifact,
  PreviewAutomationStatus,
} from "./previewAutomation.ts";

const tests = {
  keyboard: true,
  toolbar: "expanded" as const,
  safeAreas: true,
  connection: "slow" as const,
  textScale: 1.5 as const,
  reducedMotion: true,
};
const applied = {
  mobile: true,
  touch: true,
  density: 3,
  identity: "android" as const,
  profileId: "iphone-12-pro",
  orientation: "portrait" as const,
  tests,
};
const device = Schema.decodeUnknownSync(PreviewDeviceSnapshot)({
  viewport: {
    mode: "preset",
    preset: "iphone-12-pro",
    label: "Phone",
    width: 390,
    height: 844,
    device: { mode: "profile", orientation: "portrait", tests },
  },
  applied,
  chromium: "152",
  electron: "44.1.0",
  layout: { width: 390, height: 488 },
  visual: { width: 390, height: 488, scale: 1, offsetLeft: 0, offsetTop: 0 },
  geometry: {
    keyboardHeight: 300,
    toolbarHeight: 56,
    usableHeight: 488,
    smallViewportDifference: 0,
    insets: { top: 44, right: 0, bottom: 34, left: 0 },
  },
  density: 3,
  outputScale: 3,
});
it("preserves applied, pending and observed conditions through remote status encoding", () => {
  const status = Schema.decodeUnknownSync(PreviewAutomationStatus)({
    available: true,
    visible: true,
    tabId: "tab",
    url: "https://example.com",
    title: "Page",
    loading: false,
    device: { applied, pending: { mode: "fill" } },
    deviceSnapshot: device,
  });
  expect(Schema.encodeSync(PreviewAutomationStatus)(status)).toMatchObject({
    device: { applied, pending: { mode: "fill" } },
    deviceSnapshot: device,
  });
});
it("preserves recording conditions and changes through decode and tool-result encoding", () => {
  const recording = Schema.decodeUnknownSync(PreviewAutomationRecordingArtifact)({
    id: "capture",
    tabId: "tab",
    path: "/capture.webm",
    mimeType: "video/webm",
    sizeBytes: 100,
    createdAt: "2026-09-15",
    device,
    deviceChanges: [{ atMs: 25, device }],
    notice: "Recording ended on detach.",
  });
  expect(Schema.encodeSync(PreviewAutomationRecordingArtifact)(recording)).toMatchObject({
    device,
    deviceChanges: [{ atMs: 25, device }],
    notice: "Recording ended on detach.",
  });
});
it("accepts advanced device requests and rejects unbounded or incomplete gestures", () => {
  expect(
    Schema.decodeUnknownSync(PreviewAutomationEmulateInput)({
      viewport: { mode: "freeform", width: 390, height: 844, deviceMode: "mobile" },
      tests,
      reload: true,
    }),
  ).toMatchObject({ tests, reload: true });
  const decode = Schema.decodeUnknownSync(PreviewAutomationGestureInput);
  expect(() => decode({ kind: "pinch", x: 100, y: 100 })).toThrow();
  expect(() => decode({ kind: "swipe", x: 100, y: 100 })).toThrow();
  expect(() => decode({ kind: "long-press", x: 100, y: 100, durationMs: 100000 })).toThrow();
  expect(decode({ kind: "pinch", x: 100, y: 100, scale: 2 })).toMatchObject({ scale: 2 });
});
