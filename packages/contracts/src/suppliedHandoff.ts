import * as Schema from "effect/Schema";
import { PositiveInt } from "./baseSchemas.ts";

export const HandoffAuthor = Schema.Literals([
  "records_only",
  "verbatim",
  "jev_plus_writer",
  "writer_alone",
]);
export const SuppliedHandoff = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120_000)),
  author: HandoffAuthor,
  coveredRunOrdinals: Schema.Struct({ from: PositiveInt, to: PositiveInt }),
});
export type SuppliedHandoff = typeof SuppliedHandoff.Type;
