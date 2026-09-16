import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  isProjectSessionFilePath,
  OrchestrationProject,
  ProjectCreateCommand,
  ProjectSessionFiles,
} from "./orchestration.ts";

const decodeFiles = Schema.decodeUnknownSync(ProjectSessionFiles);

describe("project session files", () => {
  it("accepts relative paths inside the project and refuses the rest", () => {
    expect(decodeFiles(["SOUL.md", "syntheses/INDEX.md", "notes\\memory.md"])).toEqual([
      "SOUL.md",
      "syntheses/INDEX.md",
      "notes\\memory.md",
    ]);
    for (const bad of [
      "/etc/passwd",
      "../outside.md",
      "a/../../b.md",
      "C:\\secrets.txt",
      ".",
      "a//",
    ]) {
      expect(isProjectSessionFilePath(bad), bad).toBe(false);
      expect(() => decodeFiles([bad]), bad).toThrow();
    }
    expect(() => decodeFiles(Array.from({ length: 17 }, (_, index) => `f${index}.md`))).toThrow();
  });

  it("is optional on projects and the create command, so older payloads still decode", () => {
    const base = {
      id: "p1",
      title: "Plain",
      workspaceRoot: "/tmp/plain",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
      deletedAt: null,
    };
    const decoded = Schema.decodeUnknownSync(OrchestrationProject)(base);
    expect("sessionFiles" in decoded).toBe(false);
    const withFiles = Schema.decodeUnknownSync(OrchestrationProject)({
      ...base,
      sessionFiles: ["SOUL.md"],
    });
    expect(withFiles.sessionFiles).toEqual(["SOUL.md"]);
    const command = Schema.decodeUnknownSync(ProjectCreateCommand)({
      type: "project.create",
      commandId: "c1",
      projectId: "p1",
      title: "Assistant",
      workspaceRoot: "/tmp/assistant",
      sessionFiles: ["SOUL.md"],
      createdAt: "2026-09-11T00:00:00.000Z",
    });
    expect(command.sessionFiles).toEqual(["SOUL.md"]);
  });
});
