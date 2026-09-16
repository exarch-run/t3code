import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  boundSessionFile,
  readSessionFiles,
  renderSessionFilesBlock,
  SESSION_FILE_MAX_CHARS,
} from "./SessionFiles.ts";

const run = <A>(effect: Effect.Effect<A, unknown, NodeServices.NodeServices>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A, unknown, never>,
  );

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

  it("reads listed files from the project folder, skips missing ones, and refuses paths that leave it", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-files-"));
    const outside = await mkdtemp(join(tmpdir(), "session-files-outside-"));
    try {
      await mkdir(join(root, "syntheses"), { recursive: true });
      await writeFile(join(root, "SOUL.md"), "# Soul\n");
      await writeFile(join(root, "syntheses", "INDEX.md"), "# Syntheses\n");
      await writeFile(join(outside, "secret.md"), "nope\n");
      await symlink(join(outside, "secret.md"), join(root, "LINK.md"));
      const block = await run(
        readSessionFiles(root, [
          "SOUL.md",
          "MISSING.md",
          "syntheses/INDEX.md",
          "../secret.md",
          "/etc/hostname",
          "LINK.md",
          "",
        ]),
      );
      expect(block).toContain("## SOUL.md");
      expect(block).toContain("## syntheses/INDEX.md");
      expect(block).not.toContain("MISSING");
      expect(block).not.toContain("nope");
      expect(block).not.toContain("hostname");
      expect(await run(readSessionFiles(root, ["MISSING.md"]))).toBeUndefined();
      expect(await run(readSessionFiles(root, []))).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
