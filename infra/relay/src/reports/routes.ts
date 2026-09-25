import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as AccountDeletions from "../account/AccountDeletions.ts";
import * as RelayConfiguration from "../Config.ts";
import { publicPage } from "../publicPages.ts";
import * as AiReports from "./AiReports.ts";

// Report text travels only in request bodies. Nothing here logs a body, and
// no route takes report text or credentials in a query string, which
// Cloudflare's invocation logs would keep.

const noStore = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

const json = (status: number, body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: noStore });

const rejectionStatus: Record<AiReports.ReportRejected["reason"], number> = {
  invalid: 400,
  conflict: 409,
  rate_limited: 429,
  unavailable: 503,
};

const rejectionMessage: Record<AiReports.ReportRejected["reason"], string> = {
  invalid: "Invalid report",
  conflict: "A different report already used this id",
  rate_limited: "Try later",
  unavailable: "Reporting unavailable",
};

/**
 * Reads at most `limit` bytes of the body, whatever Content-Length says.
 * Stopping early closes the stream, which cancels the underlying reader, so an
 * endless or chunked body is never buffered past the limit. Null means too large.
 */
export const readBoundedBody = (request: HttpServerRequest.HttpServerRequest, limit: number) =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    let tooLarge = false;
    yield* request.stream.pipe(
      Stream.takeWhile((chunk) => {
        total += chunk.length;
        if (total > limit) {
          tooLarge = true;
          return false;
        }
        chunks.push(chunk);
        return true;
      }),
      Stream.runDrain,
    );
    if (tooLarge) return null;
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(body);
  });

const pathOf = (request: HttpServerRequest.HttpServerRequest) => {
  const url = HttpServerRequest.toURL(request);
  return url._tag === "Some" ? url.value.pathname : "";
};

const receiveReport = Effect.fn("relay.reports.receive")(function* (
  reports: AiReports.AiReports["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    return json(415, { error: "JSON required" });
  }
  const encoding = request.headers["content-encoding"];
  if (encoding && encoding !== "identity") return json(415, { error: "Encoding not supported" });
  const declared = Number(request.headers["content-length"] ?? "0");
  if (declared > AiReports.REPORT_BODY_LIMIT) return json(413, { error: "Report too large" });
  const body = yield* readBoundedBody(request, AiReports.REPORT_BODY_LIMIT).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (body === undefined) return json(400, { error: rejectionMessage.invalid });
  if (body === null) return json(413, { error: "Report too large" });
  return yield* reports.submit(body).pipe(
    Effect.map((receipt) => json(receipt.created ? 201 : 200, { id: receipt.id })),
    Effect.catchTags({
      ReportRejected: (error) => {
        return Effect.annotateCurrentSpan({ "relay.reports.rejected": error.reason }).pipe(
          Effect.as(json(rejectionStatus[error.reason], { error: rejectionMessage[error.reason] })),
        );
      },
      ReportStorageError: (error) =>
        Effect.logError("report storage failed", { operation: error.operation }).pipe(
          Effect.as(json(503, { error: rejectionMessage.unavailable })),
        ),
    }),
  );
});

const OperatorDeletionRequest = Schema.Struct({
  userId: Schema.String.check(Schema.isMinLength(1)),
});
const decodeOperatorDeletion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OperatorDeletionRequest),
);

export const reportRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const reports = yield* AiReports.AiReports;
    const deletions = yield* AccountDeletions.AccountDeletions;
    const config = yield* RelayConfiguration.RelayConfiguration;
    const crypto = yield* Crypto.Crypto;
    const digest = (value: string) => crypto.digest("SHA-256", new TextEncoder().encode(value));
    /** Compares SHA-256 digests in constant time, so timing reveals nothing about the token. */
    const sameSecret = (given: string, expected: string) =>
      Effect.all([digest(given), digest(expected)]).pipe(
        Effect.map(([a, b]) => {
          let difference = 0;
          for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
          return difference === 0;
        }),
      );

    // Without a configured token the operator routes don't exist.
    const operator = <E>(
      handle: (
        request: HttpServerRequest.HttpServerRequest,
      ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
    ) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const expected = config.operatorToken;
        if (!expected) return HttpServerResponse.empty({ status: 404 });
        const given = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "";
        const allowed = yield* sameSecret(given, Redacted.value(expected)).pipe(
          Effect.orElseSucceed(() => false),
        );
        if (!allowed) return json(401, { error: "Operator token required" });
        return yield* handle(request).pipe(
          Effect.catch(() => Effect.succeed(json(503, { error: "Storage unavailable" }))),
        );
      });

    const page = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const html = publicPage(pathOf(request));
      if (html === undefined) return HttpServerResponse.empty({ status: 404 });
      return HttpServerResponse.text(html, {
        contentType: "text/html; charset=utf-8",
        headers: {
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
      });
    });

    return Layer.mergeAll(
      HttpRouter.add("POST", "/v1/reports", receiveReport(reports)),
      HttpRouter.add(
        "GET",
        "/v1/reports/health",
        reports.accepting.pipe(
          Effect.map((accepting) => json(200, { ok: true, accepting })),
          Effect.orElseSucceed(() => json(503, { ok: false, accepting: false })),
        ),
      ),
      HttpRouter.add(
        "GET",
        "/v1/operator/summary",
        operator(() =>
          Effect.all({ reports: reports.summary, accountDeletions: deletions.summary }).pipe(
            Effect.map((summary) => json(200, summary)),
          ),
        ),
      ),
      HttpRouter.add(
        "GET",
        "/v1/operator/reports",
        operator(() => reports.list(50).pipe(Effect.map((list) => json(200, { reports: list })))),
      ),
      HttpRouter.add(
        "DELETE",
        "/v1/operator/reports/:id",
        operator((request) => {
          const id = pathOf(request).split("/").pop()?.toLowerCase() ?? "";
          return reports
            .remove(id)
            .pipe(
              Effect.map((removed) =>
                removed ? json(200, { id }) : json(404, { error: "Not found" }),
              ),
            );
        }),
      ),
      // For deletion requests that arrive by email: the operator looks up the
      // user id in Clerk after confirming the request, then queues the same
      // cleanup the phone's Delete account runs.
      HttpRouter.add(
        "POST",
        "/v1/operator/account-deletions",
        operator((request) =>
          readBoundedBody(request, 4_096).pipe(
            Effect.flatMap((body) => decodeOperatorDeletion(body ?? "")),
            Effect.flatMap(({ userId }) => deletions.requestByOperator(userId)),
            Effect.map((status) => json(202, status)),
            Effect.catchTag("SchemaError", () =>
              Effect.succeed(json(400, { error: "userId required" })),
            ),
          ),
        ),
      ),
      ...(["/privacy", "/support", "/terms", "/delete-account"] as const).map((path) =>
        HttpRouter.add("GET", path, page),
      ),
    );
  }),
);
