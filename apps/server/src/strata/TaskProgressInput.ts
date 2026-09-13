/**
 * Task card input: what an agent may send to strata_progress_card and how it
 * becomes a canonical write. Adapted from OpenClaw's progress card
 * (src/session-cards/progress-card-input.ts and
 * src/agents/tools/progress-card-tool.ts at commit
 * 11921d88856c0d1690b1036ff6e0e48d9ef9043b, MIT; see
 * strata/THIRD_PARTY_NOTICES.md). Validation runs on the raw tool arguments,
 * before any decoder could drop a field the model got wrong.
 */
import {
  TASK_PROGRESS_MAX_MARKDOWN_UTF8_BYTES,
  TASK_PROGRESS_MAX_STEP_UTF8_BYTES,
  TASK_PROGRESS_MAX_STEPS,
  type TaskProgressStep,
} from "@t3tools/contracts";

export class TaskProgressInputError extends Error {}

export interface NormalizedTaskProgressInput {
  markdown?: string;
  steps?: TaskProgressStep[];
}

// Zero-width and bidi control characters used to conceal text or change its
// visual order (OpenClaw src/infra/unicode-visibility.ts).
const INVISIBLE_UNICODE_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;
export const stripInvisibleUnicode = (text: string): string =>
  text.replace(INVISIBLE_UNICODE_RE, "");

const STEP_STATUSES = new Set(["pending", "in_progress", "completed"]);
const isStepStatus = (value: unknown): value is TaskProgressStep["status"] =>
  typeof value === "string" && STEP_STATUSES.has(value);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The current contract is `markdown` and `plan[].step`. Sessions that cached
 * the earlier Strata contract may still send `writeId` and `plan[].text`;
 * those decode into the same write. Anything else is a mistake the model has
 * to hear about, because a misnamed checklist must never become a silent
 * note-only update.
 */
const TOP_LEVEL_FIELDS = new Set(["markdown", "plan", "writeId"]);
const STEP_FIELDS = new Set(["step", "status", "text"]);

/** Validates and normalizes the replace-on-write task card payload. */
export function normalizeTaskProgressInput(rawArgs: unknown): NormalizedTaskProgressInput {
  const input = asRecord(rawArgs) ?? {};
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_FIELDS.has(key)) {
      throw new TaskProgressInputError(
        `unknown field "${key}"; strata_progress_card takes markdown and plan (steps as {step, status})`,
      );
    }
  }
  if (input.writeId !== undefined && typeof input.writeId !== "string") {
    throw new TaskProgressInputError("writeId is no longer needed; omit it");
  }

  let markdown: string | undefined;
  if (input.markdown !== undefined) {
    if (typeof input.markdown !== "string") {
      throw new TaskProgressInputError("markdown must be a string");
    }
    if (Buffer.byteLength(input.markdown, "utf8") > TASK_PROGRESS_MAX_MARKDOWN_UTF8_BYTES) {
      throw new TaskProgressInputError(
        `progress card markdown exceeds ${TASK_PROGRESS_MAX_MARKDOWN_UTF8_BYTES} UTF-8 bytes`,
      );
    }
    const sanitized = stripInvisibleUnicode(input.markdown);
    if (sanitized.trim()) {
      markdown = sanitized;
    }
  }

  let steps: TaskProgressStep[] | undefined;
  if (input.plan !== undefined) {
    if (!Array.isArray(input.plan)) {
      throw new TaskProgressInputError("plan must be an array");
    }
    if (input.plan.length > TASK_PROGRESS_MAX_STEPS) {
      throw new TaskProgressInputError(`plan can contain at most ${TASK_PROGRESS_MAX_STEPS} steps`);
    }
    const normalizedSteps: TaskProgressStep[] = [];
    let inProgressCount = 0;
    for (const [index, entry] of input.plan.entries()) {
      const record = asRecord(entry);
      if (!record) {
        throw new TaskProgressInputError(`plan[${index}] must be an object`);
      }
      for (const key of Object.keys(record)) {
        if (!STEP_FIELDS.has(key)) {
          throw new TaskProgressInputError(
            `plan[${index}] has an unknown field "${key}"; each step is {step, status}`,
          );
        }
      }
      const rawStep = record.step !== undefined ? record.step : record.text;
      if (typeof rawStep !== "string") {
        throw new TaskProgressInputError(`plan[${index}].step must be a string`);
      }
      if (Buffer.byteLength(rawStep, "utf8") > TASK_PROGRESS_MAX_STEP_UTF8_BYTES) {
        throw new TaskProgressInputError(
          `plan[${index}].step exceeds ${TASK_PROGRESS_MAX_STEP_UTF8_BYTES} UTF-8 bytes`,
        );
      }
      const step = stripInvisibleUnicode(rawStep);
      if (!step.trim()) {
        throw new TaskProgressInputError(`plan[${index}].step must not be empty`);
      }
      if (!isStepStatus(record.status)) {
        throw new TaskProgressInputError(
          `plan[${index}].status must be one of pending, in_progress, completed`,
        );
      }
      if (record.status === "in_progress") {
        inProgressCount += 1;
      }
      normalizedSteps.push({ step, status: record.status });
    }
    if (inProgressCount > 1) {
      throw new TaskProgressInputError("plan can contain at most one in_progress step");
    }
    if (normalizedSteps.length > 0) {
      steps = normalizedSteps;
    }
  }

  return {
    ...(markdown ? { markdown } : {}),
    ...(steps ? { steps } : {}),
  };
}

/**
 * The schema the model sees. It is the same closed object the reference tool
 * advertises, written as JSON Schema so the handler receives the raw call and
 * the validation above is the only decoder.
 */
export const TASK_PROGRESS_TOOL_JSON_SCHEMA = {
  type: "object",
  properties: {
    markdown: {
      type: "string",
      description:
        "A compact status note in Markdown, at most 8192 UTF-8 bytes. Omit it when the checklist says everything.",
    },
    plan: {
      type: "array",
      maxItems: TASK_PROGRESS_MAX_STEPS,
      description:
        "An ordered step checklist for genuinely sequential work. Send the whole list every time; it replaces the previous one. Omit it when a note says it better.",
      items: {
        type: "object",
        properties: {
          step: {
            type: "string",
            minLength: 1,
            description: "One step, at most 512 UTF-8 bytes.",
          },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed"],
            description: "pending, in_progress, or completed. At most one step is in_progress.",
          },
        },
        required: ["step", "status"],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;
