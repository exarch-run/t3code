import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExarchHostClient from "../../ExarchHostClient.ts";
import { TaskProgressRefusedError } from "../../../exarch/TaskProgressRuntime.ts";
import {
  TASK_PROGRESS_TOOL_DESCRIPTION,
  TASK_PROGRESS_TOOL_JSON_SCHEMA,
} from "../../../exarch/TaskProgressInput.ts";
import { TaskProgressAcknowledgement } from "@t3tools/contracts";

/**
 * Exarch's document tools (ExarchMD plan: Exarch and T3 as one app, phase
 * 3). Every session lists them, because this engine only ever runs beside
 * Exarch. What an agent needs to know rides in the descriptions: what Exarch
 * is, that a delivery is the owner's round, where block ids come from, that
 * every action needs a fresh actionId and a retry reuses it, and that the
 * owner's focus, reading position, and drafts are never available.
 */
const dependencies = [McpInvocationContext.McpInvocationContext, ExarchHostClient.ExarchHostClient];

const ABOUT_EXARCH =
  "Exarch is the owner's Markdown cockpit: it holds each open document with its unsaved edits and applies your document actions safely while the owner reviews them. A delivery is the owner's round, sent as a Markdown attachment on a turn; block ids in a delivery belong to that delivery, and block ids from exarch_document or exarch_resolve belong to that read. Your thread reads and acts only on documents attached to it; the attach verb in exarch_act attaches it to another open document. The owner's focus, reading position, and unsent drafts are never available.";

export const ExarchToolError = ExarchHostClient.ExarchHostError;
export type ExarchToolError = ExarchHostClient.ExarchHostError;

/** Every result is JSON Exarch produced; large bodies are bounded and say when they are truncated. */
export const ExarchResult = Schema.Record(Schema.String, Schema.Unknown).annotate({
  description: "JSON from Exarch. Large bodies are bounded and carry truncated=true when cut.",
});
export type ExarchResult = typeof ExarchResult.Type;

const OptionalPath = Schema.optional(
  Schema.String.annotate({
    description:
      "Absolute path of an open document attached to this thread. Omit it to use the document of the latest delivery.",
  }),
);

export const ExarchDocumentInput = Schema.Struct({ path: OptionalPath });
export const ExarchItemsInput = Schema.Struct({ path: OptionalPath });
export const ExarchChangesInput = Schema.Struct({
  path: OptionalPath,
  since: Schema.optional(
    Schema.String.annotate({
      description:
        "A delivery id. When given, changes since that delivery; otherwise every pending change.",
    }),
  ),
});
export const ExarchResolveInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "Absolute path of an open document attached to this thread.",
  }),
  quote: Schema.String.annotate({
    description:
      "Exact current text of the passage, copied from the live buffer, at least a few words.",
  }),
});
export const ExarchActInput = Schema.Struct({
  actionId: Schema.String.annotate({
    description:
      "A fresh id you make up for this call. A retry after a dropped connection reuses the same id and gets the original outcomes without applying anything twice.",
  }),
  entries: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description:
      'The exarch entry array: comment, question, decision, suggest, edit, reply, resolve, accept, reject, save, lead, attach. Each entry may add readId naming the exarch_document or exarch_resolve read its block id came from. Example: {"verb":"edit","anchor":{"document":"/absolute/file.md","block":"b1234abcd"},"match":"exact text","replace":"new text","readId":"r_…"}',
  }),
});
export const ExarchRenderCheckInput = Schema.Struct({
  markdown: Schema.String.annotate({
    description: "Markdown that uses Exarch components, checked the way Exarch renders it.",
  }),
});

const exarchTool = <T extends Tool.Any>(tool: T): T => tool.annotate(Tool.OpenWorld, false) as T;

const ExarchDocumentTool = exarchTool(
  Tool.make("exarch_document", {
    description: `${ABOUT_EXARCH} Read the live buffer of an attached document with block ids in the form a delivery uses. Returns readId, path, and the text; the ids belong to that read, so pass readId with entries that use them.`,
    parameters: ExarchDocumentInput,
    success: ExarchResult,
    failure: ExarchToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Read a Exarch document")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const ExarchOpenDocumentsTool = exarchTool(
  Tool.make("exarch_open_documents", {
    description:
      "List the paths of the documents open in Exarch and, for each, whether it is attached to this thread and whether this thread holds the Lead. Nothing else about them is available; attach with exarch_act to read one.",
    success: ExarchResult,
    failure: ExarchToolError,
    dependencies,
  })
    .annotate(Tool.Title, "List open Exarch documents")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const ExarchItemsTool = exarchTool(
  Tool.make("exarch_items", {
    description:
      "The open questions, decisions, suggestions, and edits on an attached document, with their ids and states. Item ids are what reply, resolve, accept, and reject entries anchor to.",
    parameters: ExarchItemsInput,
    success: ExarchResult,
    failure: ExarchToolError,
    dependencies,
  })
    .annotate(Tool.Title, "List Exarch items")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const ExarchChangesTool = exarchTool(
  Tool.make("exarch_changes", {
    description:
      "Pending changes on an attached document with who made them, and the changes since a delivery when since names one. A change you made and the owner has not kept or reverted is still pending.",
    parameters: ExarchChangesInput,
    success: ExarchResult,
    failure: ExarchToolError,
    dependencies,
  })
    .annotate(Tool.Title, "List Exarch changes")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const ExarchResolveTool = exarchTool(
  Tool.make("exarch_resolve", {
    description:
      "Find the block that holds an exact quote in an attached document. Returns readId with the block id and its current text, or the nearest candidates when the quote is missing or ambiguous. Use it after a block changed instead of guessing an old id.",
    parameters: ExarchResolveInput,
    success: ExarchResult,
    failure: ExarchToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Resolve a quote to a Exarch block")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const ExarchActTool = exarchTool(
  Tool.make("exarch_act", {
    description: `Apply document actions in Exarch now and get one outcome per entry at once: applied with the item id, or failed with the reason and nearest block candidates. ${ABOUT_EXARCH} Accept, reject, and save need the Lead. Every call needs a fresh actionId; a retry reuses it and returns the stored outcomes without applying anything twice.`,
    parameters: ExarchActInput,
    success: ExarchResult,
    failure: ExarchToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Act in a Exarch document")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const ExarchRenderCheckTool = exarchTool(
  Tool.make("exarch_render_check", {
    description:
      "Check Markdown that uses Exarch components (Callout, Verdict, MetricStrip, PhaseBoard, DecisionMatrix, BeforeAfter, Chart, EvidenceChain, AnnotatedScreenshot) the way Exarch renders it. Returns valid, the components found, and each problem with its line, message, and fix, in the words Exarch's error card uses.",
    parameters: ExarchRenderCheckInput,
    success: ExarchResult,
    failure: ExarchToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Check Exarch component Markdown")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const ExarchLibraryTool = exarchTool(
  Tool.make("exarch_library", {
    description:
      "Read the Library on the computer running Exarch: skills, discovered tool availability, link problems, shared instructions, and memory. Returns the same inventory and statuses the owner sees. Takes no arguments and changes no library files. File reads are reported separately from skill invocations. Use the central-library skill for owner-authorized file changes.",
    success: ExarchResult,
    failure: ExarchToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Read the Exarch Library")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const ExarchComponentsTool = exarchTool(
  Tool.make("exarch_components", {
    description:
      "The reference for Exarch components: one valid example of each, with the body shape it needs. Read it before writing a component into prose the owner will read in Exarch.",
    success: ExarchResult,
    failure: ExarchToolError,
    dependencies,
  })
    .annotate(Tool.Title, "Exarch component reference")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

/**
 * The writer takes its raw JSON Schema, the closed object the reference tool
 * advertises, so the handler validates the call itself: an Effect struct would
 * drop a misnamed checklist before the handler saw it (this is how the
 * September 12 review lost its steps). Description after OpenClaw's
 * progress_card (commit 11921d88, MIT; see exarch/THIRD_PARTY_NOTICES.md).
 */
const ExarchProgressCardTool = exarchTool(
  Tool.dynamic("exarch_progress_card", {
    description: TASK_PROGRESS_TOOL_DESCRIPTION,
    parameters: TASK_PROGRESS_TOOL_JSON_SCHEMA,
    success: TaskProgressAcknowledgement,
    failure: TaskProgressRefusedError,
  })
    .annotate(Tool.Title, "Update the Exarch task card")
    .annotate(Tool.Meta, { "anthropic/alwaysLoad": true })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

const ExarchProgressCardReadTool = exarchTool(
  Tool.make("exarch_progress_card_read", {
    description:
      "Read this chat's current Exarch task card, for example after a resume. Returns card with markdown, steps and revision, or null before any write and after a clear. Reading is optional; publishing never requires it.",
    success: ExarchResult,
    failure: TaskProgressRefusedError,
    dependencies: [McpInvocationContext.McpInvocationContext],
  })
    .annotate(Tool.Title, "Read the Exarch task card")
    .annotate(Tool.Meta, { "anthropic/alwaysLoad": true })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);

export const ExarchToolkit = Toolkit.make(
  ExarchDocumentTool,
  ExarchOpenDocumentsTool,
  ExarchItemsTool,
  ExarchChangesTool,
  ExarchResolveTool,
  ExarchActTool,
  ExarchRenderCheckTool,
  ExarchComponentsTool,
  ExarchLibraryTool,
  ExarchProgressCardTool,
  ExarchProgressCardReadTool,
);
