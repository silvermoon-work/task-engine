import { at, fail, timestamp } from "./json.js";
import type { TaskSnapshot } from "./types.js";

export type TaskStatusInput = Readonly<
  Pick<TaskSnapshot, "stage" | "canceled" | "eligibleAt" | "deadlineAt">
>;
export type TaskDisplayStatus =
  | "completed"
  | "failed"
  | "stopped"
  | "canceled"
  | "timedOut"
  | "stopping"
  | "running"
  | "pending"
  | "waiting";
export type TaskStatusQualifier = "demandWithdrawn" | "runNotEnded";
export interface TaskStatusPresentation {
  status: TaskDisplayStatus;
  qualifiers: TaskStatusQualifier[];
}

/** Presentation only; now is explicit epoch milliseconds, not a result timeliness verdict. */
export function aggregateTaskStatus(task: TaskStatusInput, now: number): TaskStatusPresentation {
  at(now);
  const eligibleAt = Date.parse(timestamp(task.eligibleAt));
  const deadlineAt = Date.parse(timestamp(task.deadlineAt));
  if (deadlineAt < eligibleAt) fail("invalid_request", "Deadline precedes eligibility.");
  if (typeof task.canceled !== "boolean")
    fail("invalid_request", "Expected a boolean cancellation state.");
  switch (task.stage) {
    case "completed":
    case "failed":
    case "stopped":
      return { status: task.stage, qualifiers: task.canceled ? ["demandWithdrawn"] : [] };
    case "initial":
    case "running":
    case "stopping":
      break;
    default:
      fail("invalid_request", "Unknown Task stage.");
  }
  const qualifiers: TaskStatusQualifier[] = task.stage === "initial" ? [] : ["runNotEnded"];
  if (task.canceled) return { status: "canceled", qualifiers };
  if (now > deadlineAt) return { status: "timedOut", qualifiers };
  if (task.stage !== "initial") return { status: task.stage, qualifiers: [] };
  return { status: now < eligibleAt ? "pending" : "waiting", qualifiers: [] };
}
