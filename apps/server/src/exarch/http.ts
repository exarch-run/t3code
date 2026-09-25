import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { readExarchHost } from "../mcp/ExarchHostClient.ts";

/** The application owns the address and per-launch token. Never accept a target or identity from the phone. */
const encodeHeaders = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

export const forwardExarchRequest = Effect.fn("exarch.forward")(function* (
  sessionId: string,
  incoming: boolean,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const host = readExarchHost();
  if (host.status === "unset") return HttpServerResponse.empty({ status: 404 });
  if (host.status === "invalid") return HttpServerResponse.empty({ status: 503 });
  const { token } = host;
  const target = new URL(host.origin);
  const source = new URL(request.url, "http://localhost");
  target.pathname = `/v1/${source.pathname.slice("/api/exarch/".length)}`;
  target.search = source.search;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-exarch-device": sessionId,
  };
  for (const name of ["content-type", "last-event-id"]) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  if (incoming) {
    const original: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        value !== undefined &&
        !["cookie", "host", "connection", "content-length", "transfer-encoding"].includes(name) &&
        !name.startsWith("x-exarch-")
      )
        original[name] = value;
    }
    headers["x-exarch-incoming-headers"] = yield* encodeHeaders(original);
  }
  let upstream = HttpClientRequest.make(request.method)(target.toString(), { headers });
  if (request.method === "POST")
    upstream = HttpClientRequest.bodyStream(upstream, request.stream, {
      contentType: headers["content-type"],
    });
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(upstream)
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: {
      "content-type": response.headers["content-type"] ?? "application/octet-stream",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
});
