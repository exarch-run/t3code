import * as Layer from "effect/Layer";

// Relay traffic is private operational activity. Legacy build/environment OTLP
// credentials must not turn first-party request tracing back on.
export const headlessRelayClientTracingLayer = Layer.empty;
export const serverRelayBrokerTracingLayer = Layer.empty;
