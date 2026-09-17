import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  boundSessionFile,
  readSessionFiles,
  renderSessionFilesBlock,
  SESSION_FILE_MAX_CHARS,
} from "./SessionFiles.ts";

describe("session files", () => {
  it("renders one block with a heading per file, and nothing for no files", () => {
    expect(renderSessionFilesBlock([])).toBeUndefined();
    const block = renderSessionFilesBlock([
      { path: "SOUL.md", text: "# Soul\n\nBe plain.\n", truncated: false },
      { path: "syntheses/INDEX.md", text: "# Syntheses\n", truncated: false },
    ])!;
    expect(block.startsWith("<session_files>\n")).toBe(true);
    expect(block).toContain("## SOUL.md\n\n# Soul\n\nBe plain.\n");
    expect(block).toContain("## syntheses/INDEX.md\n\n# Syntheses\n");
    expect(block.endsWith("</session_files>")).toBe(true);
  });

  it("cuts a long file with a marker and drops files past the block ceiling with a note", () => {
    const long = "x".repeat(SESSION_FILE_MAX_CHARS + 5_000);
    const bounded = boundSessionFile("MEMORY.md", long);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.length).toBeLessThan(long.length);
    expect(bounded.text).toContain("[… 5000 more characters not shown …]");
    const block = renderSessionFilesBlock(
      [
        { path: "a.md", text: "a".repeat(60), truncated: false },
        { path: "b.md", text: "b".repeat(60), truncated: false },
      ],
      100,
    )!;
    expect(block).toContain("## a.md");
    expect(block).not.toContain("## b.md");
    expect(block).toContain("1 more file not shown");
  });

  it.effect(
    "reads listed files from the project folder, skips missing ones, and refuses paths that leave it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "session-files-" });
          const outside = yield* fs.makeTempDirectoryScoped({ prefix: "session-files-outside-" });
          yield* fs.makeDirectory(path.join(root, "syntheses"), { recursive: true });
          yield* fs.writeFileString(path.join(root, "SOUL.md"), "# Soul\n");
          yield* fs.writeFileString(path.join(root, "syntheses", "INDEX.md"), "# Syntheses\n");
          yield* fs.writeFileString(path.join(outside, "secret.md"), "nope\n");
          yield* fs.symlink(path.join(outside, "secret.md"), path.join(root, "LINK.md"));
          const block = yield* readSessionFiles(root, [
            "SOUL.md",
            "MISSING.md",
            "syntheses/INDEX.md",
            "../secret.md",
            "/etc/hostname",
            "LINK.md",
            "",
          ]);
          expect(block).toContain("## SOUL.md");
          expect(block).toContain("## syntheses/INDEX.md");
          expect(block).not.toContain("MISSING");
          expect(block).not.toContain("nope");
          expect(block).not.toContain("hostname");
          expect(yield* readSessionFiles(root, ["MISSING.md"])).toBeUndefined();
          expect(yield* readSessionFiles(root, [])).toBeUndefined();
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
