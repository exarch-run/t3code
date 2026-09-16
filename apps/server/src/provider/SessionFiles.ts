import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { isProjectSessionFilePath } from "@t3tools/contracts";

/**
 * Strata's session files: files from the project folder the server places in
 * the model's context at session start, the way an assistant workspace's soul,
 * identity, user, and memory files are loaded, so no rules file has to ask the
 * agent to read them. Missing files are skipped; long files are cut with a
 * marker; the whole block has a ceiling. The rendered text is user-agnostic.
 */
export const SESSION_FILE_MAX_CHARS = 32_000;
export const SESSION_FILES_MAX_CHARS = 120_000;

export interface RenderedSessionFile {
  readonly path: string;
  readonly text: string;
  readonly truncated: boolean;
}

/** Cuts one file's text to the per-file cap with a marker the model can see. */
export function boundSessionFile(
  path: string,
  text: string,
  cap = SESSION_FILE_MAX_CHARS,
): RenderedSessionFile {
  if (text.length <= cap) return { path, text, truncated: false };
  return {
    path,
    text: `${text.slice(0, cap)}\n[… ${text.length - cap} more characters not shown …]`,
    truncated: true,
  };
}

/** One block for the prompt; empty input yields undefined so nothing is appended. */
export function renderSessionFilesBlock(
  files: ReadonlyArray<RenderedSessionFile>,
  cap = SESSION_FILES_MAX_CHARS,
): string | undefined {
  if (files.length === 0) return undefined;
  const sections: Array<string> = [];
  let used = 0;
  let omitted = 0;
  for (const file of files) {
    const section = `## ${file.path}\n\n${file.text.trim()}\n`;
    if (used + section.length > cap) {
      omitted += 1;
      continue;
    }
    sections.push(section);
    used += section.length;
  }
  const note =
    omitted > 0
      ? `\n[… ${omitted} more ${omitted === 1 ? "file" : "files"} not shown: the session files exceed their ceiling …]\n`
      : "";
  return `<session_files>\nThe following files come from the project folder and are provided at the start of this session. They carry standing instructions and facts for this project; act on them and do not restate them.\n\n${sections.join("\n")}${note}</session_files>`;
}

/**
 * Reads the project's session files from disk. A path that is not a relative
 * path inside the project folder is skipped, as is one that resolves outside
 * it through a link, so a stale or hostile entry can never read elsewhere.
 */
export const readSessionFiles = Effect.fn("readSessionFiles")(function* (
  workspaceRoot: string,
  files: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(workspaceRoot);
  const rendered: Array<RenderedSessionFile> = [];
  for (const entry of files) {
    if (!isProjectSessionFilePath(entry)) continue;
    const target = path.resolve(root, entry);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) continue;
    const real = yield* fileSystem
      .realPath(target)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (real === undefined) continue;
    const realRoot = yield* fileSystem
      .realPath(root)
      .pipe(Effect.catch(() => Effect.succeed(root)));
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) continue;
    const text = yield* fileSystem
      .readFileString(real)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (text === undefined) continue;
    rendered.push(boundSessionFile(entry, text));
  }
  return renderSessionFilesBlock(rendered);
});
