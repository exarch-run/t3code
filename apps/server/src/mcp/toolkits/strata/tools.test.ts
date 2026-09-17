import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";
import * as Context from "effect/Context";

import { StrataToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("keeps only the card tools out of Claude tool search", () => {
  for (const tool of Object.values(StrataToolkit.tools)) {
    const meta = Context.getOrUndefined(tool.annotations, Tool.Meta);
    expect(meta?.["anthropic/alwaysLoad"]).toBe(
      tool.name === "strata_progress_card" || tool.name === "strata_progress_card_read"
        ? true
        : undefined,
    );
  }
});

it("lists the eleven Strata tools with described object parameters", () => {
  expect(Object.keys(StrataToolkit.tools).sort()).toEqual([
    "strata_act",
    "strata_changes",
    "strata_components",
    "strata_document",
    "strata_items",
    "strata_library",
    "strata_open_documents",
    "strata_progress_card",
    "strata_progress_card_read",
    "strata_render_check",
    "strata_resolve",
  ]);
  for (const tool of Object.values(StrataToolkit.tools)) {
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
  const act = StrataToolkit.tools.strata_act.description ?? "";
  expect(act).toContain("fresh actionId");
  expect(act).toContain("retry reuses it");
  expect(act).toContain("Accept, reject, and save need the Lead");
  const document = StrataToolkit.tools.strata_document.description ?? "";
  expect(document).toContain("A delivery is the owner's round");
  expect(document).toContain("belong to that read");
  expect(document).toContain("focus, reading position, and unsent drafts are never available");
  expect(StrataToolkit.tools.strata_open_documents.description).toContain(
    "Nothing else about them is available",
  );
});

it("tells every model how the task card works", () => {
  const card = StrataToolkit.tools.strata_progress_card.description ?? "";
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
  const schema = Tool.getJsonSchema(StrataToolkit.tools.strata_progress_card) as {
    readonly additionalProperties?: unknown;
    readonly properties?: Record<string, unknown>;
    readonly required?: unknown;
  };
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties ?? {})).toEqual(["markdown", "plan"]);
  expect(schema.required).toBeUndefined();
  expect(StrataToolkit.tools.strata_progress_card_read.description).toContain(
    "Reading is optional",
  );
});
