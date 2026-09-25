import { describe, expect, it } from "vite-plus/test";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import * as Schema from "effect/Schema";

import { RelayApi, RelayDeviceRegistrationRequest } from "./relay.ts";

const decodeDevice = Schema.decodeUnknownExit(RelayDeviceRegistrationRequest);
const device = {
  deviceId: "device",
  label: "Phone",
  pushToken: "token",
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

describe("mobile device platforms", () => {
  it.each([
    [23, "Failure"],
    [24, "Success"],
    [37, "Success"],
  ])("enforces the Android minimum without an upper bound (API %i)", (androidApiLevel, result) => {
    expect(decodeDevice({ ...device, platform: "android", androidApiLevel })._tag).toBe(result);
  });

  it("accepts Android tokens without Apple routing and preserves older iOS registrations", () => {
    expect(decodeDevice({ ...device, platform: "android", androidApiLevel: 36 })._tag).toBe(
      "Success",
    );
    expect(decodeDevice({ ...device, platform: "ios", iosMajorVersion: 18 })._tag).toBe("Success");
  });
  it.each([
    [15, false, "Failure"],
    [16, false, "Success"],
    [17, false, "Success"],
    [17, true, "Failure"],
    [18, true, "Success"],
  ])(
    "accepts iOS %i notifications, with Live Activities (%s) only from iOS 18",
    (iosMajorVersion, liveActivitiesEnabled, result) => {
      expect(
        decodeDevice({
          ...device,
          platform: "ios",
          iosMajorVersion,
          preferences: { ...device.preferences, liveActivitiesEnabled },
        })._tag,
      ).toBe(result);
    },
  );
  it("refuses a Live Activity push-to-start token below iOS 18", () => {
    const older = {
      ...device,
      platform: "ios",
      iosMajorVersion: 17,
      preferences: { ...device.preferences, liveActivitiesEnabled: false },
    };
    expect(decodeDevice(older)._tag).toBe("Success");
    expect(decodeDevice({ ...older, pushToStartToken: "start" })._tag).toBe("Failure");
  });
  it("rejects missing platform versions and Apple activity tokens on Android", () => {
    expect(decodeDevice({ ...device, platform: "ios" })._tag).toBe("Failure");
    expect(decodeDevice({ ...device, platform: "android" })._tag).toBe("Failure");
    expect(
      decodeDevice({
        ...device,
        platform: "android",
        androidApiLevel: 36,
        pushToStartToken: "apple-token",
      })._tag,
    ).toBe("Failure");
  });
});

describe("RelayApi security", () => {
  it("describes DPoP access tokens using the HTTP DPoP authorization scheme", () => {
    const document = OpenApi.fromApi(RelayApi);

    expect(document.components.securitySchemes?.relayDpop).toEqual({
      type: "http",
      scheme: "DPoP",
      description: "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
    });
  });
});
