import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";
import * as Context from "effect/Context";

import { ExarchToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("keeps only the card tools and the guide out of Claude tool search", () => {
  for (const tool of Object.values(ExarchToolkit.tools)) {
    const meta = Context.getOrUndefined(tool.annotations, Tool.Meta);
    expect(meta?.["anthropic/alwaysLoad"], tool.name).toBe(
      tool.name === "exarch_progress_card" ||
        tool.name === "exarch_progress_card_read" ||
        tool.name === "exarch_guide"
        ? true
        : undefined,
    );
  }
});

it("offers one guide per fixed topic and nothing else", () => {
  const guide = ExarchToolkit.tools.exarch_guide;
  expect(Context.getOrUndefined(guide.annotations, Tool.Readonly)).toBe(true);
  const schema = Tool.getJsonSchema(guide) as {
    readonly properties?: Record<string, { readonly enum?: ReadonlyArray<string> }>;
    readonly required?: ReadonlyArray<string>;
  };
  expect(schema.required).toEqual(["topic"]);
  expect(schema.properties?.topic?.enum).toEqual([
    "browser",
    "rendering",
    "documents",
    "layout",
    "delegation",
    "chats",
    "workspaces",
    "schedules",
    "skills",
    "plugins",
    "private",
    "devices",
  ]);
  expect(guide.description).toContain("does not authorize");
});

it("lists the Exarch tools with described object parameters", () => {
  expect(Object.keys(ExarchToolkit.tools).sort()).toEqual([
    "exarch_act",
    "exarch_changes",
    "exarch_components",
    "exarch_document",
    "exarch_group",
    "exarch_guide",
    "exarch_html_prepare",
    "exarch_items",
    "exarch_library",
    "exarch_lifecycle",
    "exarch_open_documents",
    "exarch_personal_setup",
    "exarch_plugins",
    "exarch_progress_card",
    "exarch_progress_card_read",
    "exarch_remote_investigation",
    "exarch_render_check",
    "exarch_resolve",
    "exarch_session",
  ]);
  for (const tool of Object.values(ExarchToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(tool.description?.length ?? 0, `${tool.name} should explain itself`).toBeGreaterThan(40);
    // A tool that takes nothing exports no properties; every other one is a described object.
    const properties = Object.entries(schema.properties ?? {});
    if (properties.length > 0) {
      expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
      expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
      expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    }
    for (const [field, fieldSchema] of properties) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what the agent must pass`,
      ).toBe(true);
    }
  }
});

it("tells the agent what it must know at session start", () => {
  const act = ExarchToolkit.tools.exarch_act.description ?? "";
  expect(act).toContain("fresh actionId");
  expect(act).toContain("retry reuses it");
  expect(act).toContain("Accept, reject, and save need the Lead");
  const document = ExarchToolkit.tools.exarch_document.description ?? "";
  expect(document).toContain("A delivery is the owner's round");
  expect(document).toContain("belong to that read");
  expect(document).toContain("focus, reading position, and unsent drafts are never available");
  expect(ExarchToolkit.tools.exarch_open_documents.description).toContain(
    "Nothing else about them is available",
  );
});

it("teaches the current document verbs, not retired ones", () => {
  const actSchema = Tool.getJsonSchema(ExarchToolkit.tools.exarch_act) as {
    readonly properties?: Record<string, { readonly description?: string }>;
  };
  const entries = actSchema.properties?.entries?.description ?? "";
  expect(entries).toContain("attach, open");
  expect(entries).not.toMatch(/\bsuggest,/);
  expect(entries).toContain("retired suggest verb is refused");
  expect(entries).toContain("not a suggestion awaiting acceptance");
  const items = ExarchToolkit.tools.exarch_items.description ?? "";
  expect(items).toContain("your edits are never items");
  expect(items).not.toContain("suggestions");
  const changes = ExarchToolkit.tools.exarch_changes.description ?? "";
  expect(changes).toContain("An applied edit is current wording");
  expect(changes).not.toContain("kept or reverted");
  expect(ExarchToolkit.tools.exarch_library.description).toContain("exarch_guide");
  for (const tool of Object.values(ExarchToolkit.tools)) {
    const title = Context.getOrUndefined(tool.annotations, Tool.Title) ?? "";
    expect(title, `${tool.name} title`).not.toContain("a Exarch");
  }
});

it("tells every model how the task card works", () => {
  const card = ExarchToolkit.tools.exarch_progress_card.description ?? "";
  expect(card).toContain("Create a card only for substantial work");
  expect(card).toContain("at least two meaningful sequential steps");
  expect(card).toContain("Existing cards may still be updated or cleared");
  expect(card).toContain(
    "Do not create a card for greetings, quick questions, or single-step requests",
  );
  expect(card).toContain("The checklist is optional");
  expect(card).toContain("Each call replaces the whole card");
  expect(card).toContain("Call with both parts empty to clear");
  expect(card).not.toContain("writeId");
  expect(card).not.toContain("running turn");
  expect(card).not.toContain("Only the parent");
  const schema = Tool.getJsonSchema(ExarchToolkit.tools.exarch_progress_card) as {
    readonly additionalProperties?: unknown;
    readonly properties?: Record<string, unknown>;
    readonly required?: unknown;
  };
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties ?? {})).toEqual(["markdown", "plan"]);
  expect(schema.required).toBeUndefined();
  expect(ExarchToolkit.tools.exarch_progress_card_read.description).toContain(
    "Reading is optional",
  );
});
