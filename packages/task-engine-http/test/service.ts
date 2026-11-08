import {
  type CoordinatorService,
  object,
  type TaskRequest,
  type TaskService,
  validateBundleReference,
} from "@silvermoon-work/task-protocol";

export const fixtureBundle = {
  cid: "bafybeigdyrzt5sfp7udm7hu76u7ydwfmksn3y3sc57x4taoj7c3x2m3yuy",
  hint: "http://localhost:8080",
};
/** Controlled coordinator for transport races, not a production Bundle-consumption proof. */
export function coordinatorService(core: CoordinatorService): TaskService {
  const originals = new Map<string, TaskRequest>();
  const overrides = {
    async submit(value: unknown, caller: Parameters<TaskService["submit"]>[1]) {
      const request = object(value);
      validateBundleReference(request.bundle);
      const snapshot = core.submit({ ...request, type: "echo" }, caller);
      originals.set(snapshot.requestId, request as TaskRequest);
      return {
        status: "accepted" as const,
        requestId: snapshot.requestId,
        taskId: snapshot.taskId,
      };
    },
    getRequest(id: string, caller: Parameters<TaskService["getRequest"]>[1]) {
      const original = core.getRequest(id, caller);
      return originals.get(id) ?? { ...original, bundle: fixtureBundle };
    },
    async getRequestStatus(
      id: string,
      _options: object,
      caller: Parameters<TaskService["getRequest"]>[1],
    ) {
      const original = core.getRequest(id, caller);
      const tasks = core.listTasks({}, {}, caller);
      const task = tasks.tasks.find((item) => item.requestId === original.requestId)!;
      return { status: "accepted" as const, requestId: id, taskId: task.taskId };
    },
  };
  return new Proxy(core, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as TaskService;
}
