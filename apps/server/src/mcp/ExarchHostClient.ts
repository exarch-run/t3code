import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/**
 * The private local channel to Exarch (ExarchMD plan: Exarch and T3 as one
 * app, phase 3). Exarch launches this engine with `EXARCH_HOST_URL` and
 * `EXARCH_HOST_TOKEN` in its environment; a developer running the dev server
 * sources the same two values from Exarch's `exarch-host.env`. Every tool
 * request is one JSON POST carrying the invocation's thread and environment
 * ids, so Exarch can refuse a call that does not belong to the engine it is
 * running. A lost write reply is uncertain: retries must retain the action ID.
 */
export const EXARCH_HOST_URL = "EXARCH_HOST_URL";
export const EXARCH_HOST_TOKEN = "EXARCH_HOST_TOKEN";
export const EXARCH_NOT_CONNECTED_MESSAGE = "Exarch is not connected. Connect Exarch and retry.";
export const DEFAULT_EXARCH_REQUEST_TIMEOUT_MS = 30_000;

export class ExarchNotConnectedError extends Schema.TaggedError<ExarchNotConnectedError>()(
  "ExarchNotConnectedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return EXARCH_NOT_CONNECTED_MESSAGE;
  }
}

/** A request was attempted, but no authoritative outcome reached the caller. */
export class ExarchOutcomeUncertainError extends Schema.TaggedError<ExarchOutcomeUncertainError>()(
  "ExarchOutcomeUncertainError",
  { actionId: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `The outcome of Exarch action ${this.actionId} is unknown. It may already have been applied. Retry exarch_act with the same actionId ${JSON.stringify(this.actionId)} and the same entries. Do not create a new action ID or repeat it in a exarch block.`;
  }
}

/** Exarch answered and refused: the code names the rule (NOT_ATTACHED, NOT_LEAD, block changed, …). */
export class ExarchToolFailedError extends Schema.TaggedError<ExarchToolFailedError>()(
  "ExarchToolFailedError",
  { tool: Schema.String, code: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `${this.code}: ${this.detail}`;
  }
}

export const ExarchHostError = Schema.Union([
  ExarchNotConnectedError,
  ExarchToolFailedError,
  ExarchOutcomeUncertainError,
]);
export type ExarchHostError = typeof ExarchHostError.Type;

export interface ExarchHostRequest {
  readonly tool: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly input: unknown;
}

export interface ExarchHostClientShape {
  readonly invoke: (request: ExarchHostRequest) => Effect.Effect<unknown, ExarchHostError>;
}

export class ExarchHostClient extends Context.Service<ExarchHostClient, ExarchHostClientShape>()(
  "t3/mcp/ExarchHostClient",
) {}

export interface ExarchHostClientOptions {
  /** Read at every call, so a developer's sourced variables and tests both apply. */
  readonly env?: () => NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

interface ExarchHostReply {
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const readReply = async (response: Response): Promise<ExarchHostReply> => {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as ExarchHostReply) : {};
  } catch {
    return {};
  }
};

export function makeExarchHostClient(options: ExarchHostClientOptions = {}): ExarchHostClientShape {
  const env = options.env ?? (() => process.env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXARCH_REQUEST_TIMEOUT_MS;
  return {
    invoke: Effect.fn("ExarchHostClient.invoke")(function* (request) {
      const variables = env();
      const url = variables[EXARCH_HOST_URL]?.trim();
      const token = variables[EXARCH_HOST_TOKEN]?.trim();
      if (!url || !token) {
        return yield* new ExarchNotConnectedError({ reason: "host variables unset" });
      }
      const actionId =
        request.tool === "exarch_act" &&
        typeof request.input === "object" &&
        request.input !== null &&
        "actionId" in request.input &&
        typeof request.input.actionId === "string"
          ? request.input.actionId
          : null;
      const uncertain = (cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        return actionId === null
          ? new ExarchNotConnectedError({ reason })
          : new ExarchOutcomeUncertainError({ actionId, reason });
      };
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(`${url.replace(/\/+$/, "")}/tools/${request.tool}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: encodeJsonText({
              threadId: request.threadId,
              environmentId: request.environmentId,
              input: request.input ?? {},
            }),
            signal: AbortSignal.timeout(timeoutMs),
          }),
        catch: uncertain,
      });
      const reply = yield* Effect.tryPromise({
        try: () => readReply(response),
        catch: uncertain,
      });
      if (response.ok && reply.ok === true) return reply.result;
      if (
        actionId !== null &&
        (response.ok || response.status >= 500) &&
        !(reply.ok === false && typeof reply.error?.code === "string")
      ) {
        return yield* uncertain(`Exarch answered ${response.status} without a valid outcome.`);
      }
      const code =
        typeof reply.error?.code === "string" ? reply.error.code : `HTTP_${response.status}`;
      const detail =
        typeof reply.error?.message === "string"
          ? reply.error.message
          : `Exarch answered ${response.status} without a reason.`;
      return yield* new ExarchToolFailedError({ tool: request.tool, code, detail });
    }),
  };
}

export const layer = (options: ExarchHostClientOptions = {}): Layer.Layer<ExarchHostClient> =>
  Layer.succeed(ExarchHostClient, makeExarchHostClient(options));
