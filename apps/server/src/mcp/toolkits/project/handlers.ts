import { OrchestratorMcpFailure, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import { launchAgentThreads } from "../../AgentThreadLaunch.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import { newCommandId, readCaller, readMutationCaller, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
const mutation = Effect.gen(function* () {
  const { caller } = yield* readMutationCaller();
  if (
    caller.archivedAt !== null ||
    caller.runtimeMode !== "full-access" ||
    caller.interactionMode !== "default"
  )
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Project changes require a live full-access/default calling thread.",
    });
  return yield* Project.ProjectService;
});
export const ProjectHandlersLive = ProjectToolkit.toLayer(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return {
      t3_thread_launch: (input: Parameters<typeof launchAgentThreads>[0]) =>
        launchAgentThreads(input).pipe(Effect.provideService(Path.Path, path)),
      t3_project_list: (input) =>
        Effect.gen(function* () {
          const projects = yield* access;
          const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
          const rows = snapshot.projects.filter((project) => project.deletedAt === null);
          const start = input.cursor ?? 0,
            end = start + (input.limit ?? 20);
          return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
        }),
      t3_project_read: (input) =>
        Effect.gen(function* () {
          const projects = yield* access;
          const result = yield* projects
            .getById(input.projectId)
            .pipe(Effect.mapError(unavailable));
          if (Option.isNone(result))
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            });
          return result.value;
        }),
      t3_project_create: (input) =>
        Effect.gen(function* () {
          const projects = yield* mutation;
          const commandId = yield* newCommandId();
          return yield* projects
            .create({ ...input, commandId, projectId: ProjectId.make(commandId) })
            .pipe(Effect.mapError(projectFailure));
        }),
      t3_project_update: (input) =>
        Effect.gen(function* () {
          const projects = yield* mutation;
          return yield* projects
            .update({ ...input, commandId: yield* newCommandId() })
            .pipe(Effect.mapError(projectFailure));
        }),
      t3_project_delete: (input) =>
        Effect.gen(function* () {
          const projects = yield* mutation;
          return yield* projects
            .delete({ ...input, commandId: yield* newCommandId() })
            .pipe(Effect.mapError(projectFailure));
        }),
      t3_project_clone: (input) =>
        Effect.gen(function* () {
          yield* mutation;
          const repositories = yield* Repositories.SourceControlRepositoryService;
          return yield* repositories.cloneRepository(input).pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: error.detail,
                }),
            ),
          );
        }),
    };
  }),
);
