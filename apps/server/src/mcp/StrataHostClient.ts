import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/**
 * The private local channel to Strata (StrataMD plan: Strata and T3 as one
 * app, phase 3). Strata launches this engine with `STRATA_HOST_URL` and
 * `STRATA_HOST_TOKEN` in its environment; a developer running the dev server
 * sources the same two values from Strata's `strata-host.env`. Every tool
 * request is one JSON POST carrying the invocation's thread and environment
 * ids, so Strata can refuse a call that does not belong to the engine it is
 * running. An unset variable or an unreachable host is one error the agent
 * can act on: propose the action in a strata block instead.
 */
export const STRATA_HOST_URL = "STRATA_HOST_URL";
export const STRATA_HOST_TOKEN = "STRATA_HOST_TOKEN";
export const STRATA_NOT_CONNECTED_MESSAGE =
  "Strata is not connected. Propose the action in a strata block instead.";
export const DEFAULT_STRATA_REQUEST_TIMEOUT_MS = 30_000;

export class StrataNotConnectedError extends Schema.TaggedError<StrataNotConnectedError>()(
  "StrataNotConnectedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return STRATA_NOT_CONNECTED_MESSAGE;
  }
}

/** Strata answered and refused: the code names the rule (NOT_ATTACHED, NOT_LEAD, block changed, …). */
export class StrataToolFailedError extends Schema.TaggedError<StrataToolFailedError>()(
  "StrataToolFailedError",
  { tool: Schema.String, code: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `${this.code}: ${this.detail}`;
  }
}

export const StrataHostError = Schema.Union([StrataNotConnectedError, StrataToolFailedError]);
export type StrataHostError = typeof StrataHostError.Type;

export interface StrataHostRequest {
  readonly tool: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly input: unknown;
}

export interface StrataHostClientShape {
  readonly invoke: (request: StrataHostRequest) => Effect.Effect<unknown, StrataHostError>;
}

export class StrataHostClient extends Context.Service<StrataHostClient, StrataHostClientShape>()(
  "t3/mcp/StrataHostClient",
) {}

export interface StrataHostClientOptions {
  /** Read at every call, so a developer's sourced variables and tests both apply. */
  readonly env?: () => NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

interface StrataHostReply {
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

const readReply = async (response: Response): Promise<StrataHostReply> => {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as StrataHostReply) : {};
  } catch {
    return {};
  }
};

export function makeStrataHostClient(options: StrataHostClientOptions = {}): StrataHostClientShape {
  const env = options.env ?? (() => process.env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STRATA_REQUEST_TIMEOUT_MS;
  return {
    invoke: Effect.fn("StrataHostClient.invoke")(function* (request) {
      const variables = env();
      const url = variables[STRATA_HOST_URL]?.trim();
      const token = variables[STRATA_HOST_TOKEN]?.trim();
      if (!url || !token) {
        return yield* new StrataNotConnectedError({ reason: "host variables unset" });
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(`${url.replace(/\/+$/, "")}/tools/${request.tool}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              threadId: request.threadId,
              environmentId: request.environmentId,
              input: request.input ?? {},
            }),
            signal: AbortSignal.timeout(timeoutMs),
          }),
        catch: (cause) =>
          new StrataNotConnectedError({
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      const reply = yield* Effect.tryPromise({
        try: () => readReply(response),
        catch: (cause) =>
          new StrataNotConnectedError({
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      if (response.ok && reply.ok === true) return reply.result;
      const code = typeof reply.error?.code === "string" ? reply.error.code : `HTTP_${response.status}`;
      const detail =
        typeof reply.error?.message === "string"
          ? reply.error.message
          : `Strata answered ${response.status} without a reason.`;
      return yield* new StrataToolFailedError({ tool: request.tool, code, detail });
    }),
  };
}

export const layer = (options: StrataHostClientOptions = {}): Layer.Layer<StrataHostClient> =>
  Layer.succeed(StrataHostClient, makeStrataHostClient(options));
