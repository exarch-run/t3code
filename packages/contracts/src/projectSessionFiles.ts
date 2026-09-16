import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PROJECT_SESSION_FILES_MAX = 16;
export const ProjectSessionFile = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) =>
      isProjectSessionFilePath(value) || "must be a relative path inside the project folder",
  ),
);
export const ProjectSessionFiles = Schema.Array(ProjectSessionFile).check(
  Schema.isMaxLength(PROJECT_SESSION_FILES_MAX),
);
export function isProjectSessionFilePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value)
  )
    return false;
  if (value.includes("\0")) return false;
  const segments = value.split(/[\\/]+/);
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

