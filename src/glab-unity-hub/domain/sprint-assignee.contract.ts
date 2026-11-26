/** @implements spec/feature/glab-unity-hub.md — C-6 mayUpdateSprintTask (guh-C-6) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [task, actor] = args as [{ assigneeId: string | null }, string | null];
    return result === (actor !== null && task.assigneeId !== null && task.assigneeId === actor);
  },
};
