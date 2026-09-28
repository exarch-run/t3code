import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

/**
 * Project session files: files whose contents go into the model's context at
 * session start. Exarch sets them on project create and update, and reads them
 * back from the project shell. They live in `projection_projects.session_files_json`
 * (Exarch migration `1_ProjectSessionFiles`).
 */

/**
 * The column as a row field. A NULL column, as rows from before the column
 * have, reads back as an absent field; an absent field writes NULL. An empty
 * list is stored as `[]`, so an explicit clear survives.
 */
export const SessionFilesColumn = Schema.optionalKey(
  Schema.NullOr(Schema.fromJsonString(Schema.Array(Schema.String))),
).pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.Array(Schema.String)), {
    decode: SchemaGetter.transformOptional((value) =>
      Option.filter(value, (files) => files !== null),
    ),
    encode: SchemaGetter.transformOptional((value) => Option.some(Option.getOrNull(value))),
  }),
);

/** Carries `sessionFiles` from a command, event payload or row only when it is set. */
export const withSessionFiles = (source: {
  readonly sessionFiles?: ReadonlyArray<string> | undefined;
}): { readonly sessionFiles?: ReadonlyArray<string> } =>
  source.sessionFiles === undefined ? {} : { sessionFiles: source.sessionFiles };
