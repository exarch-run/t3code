import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as StrataHostClient from "../../StrataHostClient.ts";
import { TaskProgressRefusedError } from "../../../strata/TaskProgressRuntime.ts";

/**
 * Strata's document tools (StrataMD plan: Strata and T3 as one app, phase
 * 3). Every session lists them, because this engine only ever runs beside
 * Strata. What an agent needs to know rides in the descriptions: what Strata
 * is, that a delivery is the owner's round, where block ids come from, that
 * every action needs a fresh actionId and a retry reuses it, and that the
 * owner's focus, reading position, and drafts are never available.
 */
const dependencies = [McpInvocationContext.McpInvocationContext, StrataHostClient.StrataHostClient];

const ABOUT_STRATA =
  "Strata is the owner's Markdown cockpit: it holds each open document with its unsaved edits and applies your document actions safely while the owner reviews them. A delivery is the owner's round, sent as a Markdown attachment on a turn; block ids in a delivery belong to that delivery, and block ids from strata_document or strata_resolve belong to that read. Your thread reads and acts only on documents attached to it; the attach verb in strata_act attaches it to another open document. The owner's focus, reading position, and unsent drafts are never available.";

export const StrataToolError = StrataHostClient.StrataHostError;
export type StrataToolError = StrataHostClient.StrataHostError;

/** Every result is JSON Strata produced; large bodies are bounded and say when they are truncated. */
export const StrataResult = Schema.Record(Schema.String, Schema.Unknown).annotate({
  description: "JSON from Strata. Large bodies are bounded and carry truncated=true when cut.",
});
export type StrataResult = typeof StrataResult.Type;

const OptionalPath = Schema.optional(
  Schema.String.annotate({
    description:
      "Absolute path of an open document attached to this thread. Omit it to use the document of the latest delivery.",
  }),
);

export const StrataDocumentInput = Schema.Struct({ path: OptionalPath });
export const StrataItemsInput = Schema.Struct({ path: OptionalPath });
export const StrataChangesInput = Schema.Struct({
  path: OptionalPath,
  since: Schema.optional(
    Schema.String.annotate({
      description:
        "A delivery id. When given, changes since that delivery; otherwise every pending change.",
    }),
  ),
});
export const StrataResolveInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path of an open document attached to this thread.",
  }),
  quote: Schema.String.annotate({
    description:
      "Exact current text of the passage, copied from the live buffer, at least a few words.",
  }),
});
export const StrataActInput = Schema.Struct({
  actionId: Schema.String.annotate({
    description:
      "A fresh id you make up for this call. A retry after a dropped connection reuses the same id and gets the original outcomes without applying anything twice.",
  }),
  entries: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description:
      'The strata entry array: comment, question, decision, suggest, edit, reply, resolve, accept, reject, save, lead, attach. Each entry may add readId naming the strata_document or strata_resolve read its block id came from. Example: {"verb":"edit","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"match":"exact text","replace":"new text","readId":"r_…"}',
  }),
});
export const StrataRenderCheckInput = Schema.Struct({
  markdown: Schema.String.annotate({
    description: "Markdown that uses Strata components, checked the way Strata renders it.",
  }),
});

export const StrataProgressCardInput = Schema.Struct({
  writeId: Schema.String.annotate({
    description:
      "A fresh id you make up for this update. A retry after a dropped connection reuses the same id and returns the original receipt without writing twice.",
  }),
  markdown: Schema.optional(
    Schema.String.annotate({
      description:
        "General status as Markdown: what is done, what is happening, what is blocked, what was found. Up to 8 KiB. Omit it when the checklist says everything.",
    }),
  ),
  plan: Schema.optional(
    Schema.Array(
      Schema.Struct({
        text: Schema.String.annotate({ description: "One step, 1–500 characters." }),
        status: Schema.Literals(["pending", "in_progress", "completed"]).annotate({
          description: "pending, in_progress, or completed. At most one step is in_progress.",
        }),
      }),
    ).annotate({
      description:
        "An ordered checklist of at most 50 steps. Send the whole list every time; it replaces the previous one.",
    }),
  ),
});

const strataTool = <T extends Tool.Any>(tool: T): T => tool.annotate(Tool.OpenWorld, false) as T;

const StrataDocumentTool = strataTool(
  Tool.make("strata_document", {
    description: `${ABOUT_STRATA} Read the live buffer of an attached document with block ids in the form a delivery uses. Returns readId, path, and the text; the ids belong to that read, so pass readId with entries that use them.`,
    parameters: StrataDocumentInput,
    success: StrataResult,
    failure: StrataToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Read a Strata document")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const StrataOpenDocumentsTool = strataTool(
  Tool.make("strata_open_documents", {
    description:
      "List the paths of the documents open in Strata and, for each, whether it is attached to this thread and whether this thread holds the Lead. Nothing else about them is available; attach with strata_act to read one.",
    success: StrataResult,
    failure: StrataToolError,
    dependencies,
  })
    .annotate(Tool.Title, "List open Strata documents")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const StrataItemsTool = strataTool(
  Tool.make("strata_items", {
    description:
      "The open questions, decisions, suggestions, and edits on an attached document, with their ids and states. Item ids are what reply, resolve, accept, and reject entries anchor to.",
    parameters: StrataItemsInput,
    success: StrataResult,
    failure: StrataToolError,
    dependencies,
  })
    .annotate(Tool.Title, "List Strata items")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const StrataChangesTool = strataTool(
  Tool.make("strata_changes", {
    description:
      "Pending changes on an attached document with who made them, and the changes since a delivery when since names one. A change you made and the owner has not kept or reverted is still pending.",
    parameters: StrataChangesInput,
    success: StrataResult,
    failure: StrataToolError,
    dependencies,
  })
    .annotate(Tool.Title, "List Strata changes")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const StrataResolveTool = strataTool(
  Tool.make("strata_resolve", {
    description:
      "Find the block that holds an exact quote in an attached document. Returns readId with the block id and its current text, or the nearest candidates when the quote is missing or ambiguous. Use it after a block changed instead of guessing an old id.",
    parameters: StrataResolveInput,
    success: StrataResult,
    failure: StrataToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Resolve a quote to a Strata block")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const StrataActTool = strataTool(
  Tool.make("strata_act", {
    description: `Apply document actions in Strata now and get one outcome per entry at once: applied with the item id, or failed with the reason and nearest block candidates. ${ABOUT_STRATA} Accept, reject, and save need the Lead. Every call needs a fresh actionId; a retry reuses it and returns the stored outcomes without applying anything twice.`,
    parameters: StrataActInput,
    success: StrataResult,
    failure: StrataToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Act in a Strata document")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const StrataRenderCheckTool = strataTool(
  Tool.make("strata_render_check", {
    description:
      "Check Markdown that uses Strata components (Callout, Verdict, MetricStrip, PhaseBoard, DecisionMatrix, BeforeAfter, Chart, EvidenceChain, AnnotatedScreenshot) the way Strata renders it. Returns valid, the components found, and each problem with its line, message, and fix, in the words Strata's error card uses.",
    parameters: StrataRenderCheckInput,
    success: StrataResult,
    failure: StrataToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Check Strata component Markdown")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const StrataComponentsTool = strataTool(
  Tool.make("strata_components", {
    description:
      "The reference for Strata components: one valid example of each, with the body shape it needs. Read it before writing a component into prose the owner will read in Strata.",
    success: StrataResult,
    failure: StrataToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Strata component reference")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const StrataProgressCardTool = strataTool(
  Tool.make("strata_progress_card", {
    description:
      "Keep Strata's task card current. Strata shows one card beside the owner's composer for this chat: a general Markdown status, an ordered checklist, or both. Every call replaces the whole card; omitted parts are removed. Use it for substantial work: write it when you start, update it at meaningful milestones or blockers, and write the result before you finish. Not on every turn, and not for a short answer or a question. Do not repeat checklist facts in the note. The main agent keeps the card; subagents leave it alone. Every call needs a fresh writeId; a retry reuses it and returns the original receipt. No read is required first. Writes are accepted only while this chat has a running turn.",
    parameters: StrataProgressCardInput,
    success: StrataResult,
    failure: TaskProgressRefusedError,
    dependencies: [McpInvocationContext.McpInvocationContext],
  })
    .annotate(Tool.Title, "Update the Strata task card")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const StrataProgressCardReadTool = strataTool(
  Tool.make("strata_progress_card_read", {
    description:
      "Read this chat's current Strata task card, for example after a resume. Returns card, which is null before any write. Reading is optional; publishing never requires it.",
    success: StrataResult,
    failure: TaskProgressRefusedError,
    dependencies: [McpInvocationContext.McpInvocationContext],
  })
    .annotate(Tool.Title, "Read the Strata task card")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

export const StrataToolkit = Toolkit.make(
  StrataDocumentTool,
  StrataOpenDocumentsTool,
  StrataItemsTool,
  StrataChangesTool,
  StrataResolveTool,
  StrataActTool,
  StrataRenderCheckTool,
  StrataComponentsTool,
  StrataProgressCardTool,
  StrataProgressCardReadTool,
);
