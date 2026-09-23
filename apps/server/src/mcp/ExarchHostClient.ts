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
 *
 * A plugin operation may run for Exarch's full ten-minute command limit, so
 * it gets its own deadline, and a lost reply means "check its status", never
 * "run it again". Every request asks Exarch to stop the work if this engine
 * abandons the call (a cancelled tool call or a deadline). Exarch versions
 * that predate the header ignore it and finish the work as before.
 */
export const EXARCH_HOST_URL = "EXARCH_HOST_URL";
export const EXARCH_HOST_TOKEN = "EXARCH_HOST_TOKEN";
export const EXARCH_NOT_CONNECTED_MESSAGE = "Exarch is not connected. Connect Exarch and retry.";
export const DEFAULT_EXARCH_REQUEST_TIMEOUT_MS = 30_000;
/** Exarch stops a plugin command after ten minutes; this leaves it time to answer. */
export const EXARCH_PLUGIN_TIMEOUT_MS = 610_000;
/** Asks Exarch to cancel the operation when this request's connection closes before the reply. */
export const EXARCH_CANCEL_ON_CLOSE_HEADER = "x-exarch-cancel-on-close";

/** Where Exarch listens and the token it issued, after the checks every path shares. */
export type ExarchHostTarget =
  | { readonly status: "ready"; readonly origin: URL; readonly token: string }
  | { readonly status: "unset" }
  | { readonly status: "invalid" };

/**
 * The one reading of Exarch's address for tools, phone forwarding and plugins.
 * The per-launch token only ever travels to a plain-HTTP loopback address
 * without userinfo, which is all Exarch ever hands the engine.
 */
export function readExarchHost(env: NodeJS.ProcessEnv = process.env): ExarchHostTarget {
  const url = env[EXARCH_HOST_URL]?.trim();
  const token = env[EXARCH_HOST_TOKEN]?.trim();
  if (!url || !token) return { status: "unset" };
  let origin: URL;
  try {
    origin = new URL(url);
  } catch {
    return { status: "invalid" };
  }
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.username ||
    origin.password
  ) {
    return { status: "invalid" };
  }
  return { status: "ready", origin, token };
}

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

/** A plugin operation was sent, but its outcome never came back. Running it again could run it twice. */
export class ExarchPluginOutcomeUncertainError extends Schema.TaggedError<ExarchPluginOutcomeUncertainError>()(
  "ExarchPluginOutcomeUncertainError",
  { action: Schema.String, pluginId: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `The outcome of exarch_plugins ${this.action} for plugin ${this.pluginId} is unknown. It may have finished or may still be running. Call exarch_plugins with action "status" for ${this.pluginId} before you ${this.action} it again.`;
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
  ExarchPluginOutcomeUncertainError,
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
  /** The deadline for a plugin operation other than list and status. */
  readonly pluginTimeoutMs?: number;
}

interface ExarchHostReply {
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A plugin action that changes or runs something; list and status only read. */
const pluginOperation = (request: ExarchHostRequest) => {
  const input = request.input;
  if (request.tool !== "exarch_plugins" || typeof input !== "object" || input === null) return null;
  const action = "action" in input ? input.action : undefined;
  const id = "id" in input ? input.id : undefined;
  return typeof action === "string" && action !== "list" && action !== "status"
    ? { action, pluginId: typeof id === "string" ? id : "(none)" }
    : null;
};

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
  const pluginTimeoutMs = options.pluginTimeoutMs ?? EXARCH_PLUGIN_TIMEOUT_MS;
  return {
    invoke: Effect.fn("ExarchHostClient.invoke")(function* (request) {
      const host = readExarchHost(env());
      if (host.status !== "ready") {
        return yield* new ExarchNotConnectedError({
          reason: host.status === "unset" ? "host variables unset" : "host address is not loopback",
        });
      }
      const actionId =
        request.tool === "exarch_act" &&
        typeof request.input === "object" &&
        request.input !== null &&
        "actionId" in request.input &&
        typeof request.input.actionId === "string"
          ? request.input.actionId
          : null;
      const plugin = pluginOperation(request);
      const uncertain = (cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        if (actionId !== null) return new ExarchOutcomeUncertainError({ actionId, reason });
        if (plugin !== null) return new ExarchPluginOutcomeUncertainError({ ...plugin, reason });
        return new ExarchNotConnectedError({ reason });
      };
      // One signal covers the request and the reply body, so a cancelled tool
      // call closes the connection and Exarch can stop the work.
      const { response, reply } = yield* Effect.tryPromise({
        try: async (interrupted) => {
          const response = await fetchImpl(new URL(`/tools/${request.tool}`, host.origin), {
            method: "POST",
            headers: {
              authorization: `Bearer ${host.token}`,
              "content-type": "application/json",
              [EXARCH_CANCEL_ON_CLOSE_HEADER]: "1",
            },
            body: encodeJsonText({
              threadId: request.threadId,
              environmentId: request.environmentId,
              input: request.input ?? {},
            }),
            signal: AbortSignal.any([
              interrupted,
              AbortSignal.timeout(plugin === null ? timeoutMs : pluginTimeoutMs),
            ]),
            redirect: "error",
          });
          return { response, reply: await readReply(response) };
        },
        catch: uncertain,
      });
      if (response.ok && reply.ok === true) return reply.result;
      if (
        (actionId !== null || plugin !== null) &&
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
