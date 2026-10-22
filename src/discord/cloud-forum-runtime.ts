import type { Guild, Message } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { ObservationStore } from "../cloud-observation/store.js";
import { cloudForum } from "./cloud-forum.js";

/** Owns polling, the observation connection, and drain before closing that connection. */
export function startCloudForum(input: { root: string; guild: Guild; forumId: string;
  config: DiscordConfigRepo; allowed: (userId: string) => boolean | Promise<boolean>;
  warn: (message: string) => void }): {
    handles: (message: Message) => boolean; answer: (message: Message) => Promise<void>; stop: () => Promise<void>;
  } {
  if (!input.root || !input.forumId) throw new Error("cloud_forum_configuration_incomplete");
  const store = new ObservationStore(input.root);
  let stopped = false;
  const tasks = new Set<Promise<void>>();
  const track = (task: Promise<void>): Promise<void> => {
    tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task)); return task;
  };
  const forum = cloudForum({ ...input, store, now: Date.now, stopped: () => stopped });
  const refresh = (): void => { if (!stopped) void track(forum.refresh()).catch(() => input.warn("Cloud forum delivery incomplete; inspect pending delivery before retry")); };
  const timer = setInterval(refresh, 15_000); timer.unref(); refresh();
  let closing: Promise<void> | undefined;
  return {
    handles: forum.handles,
    answer: message => stopped ? Promise.reject(new Error("cloud_forum_stopping")) : track(forum.answer(message)),
    stop() {
      if (!closing) { stopped = true; clearInterval(timer); closing = Promise.allSettled([...tasks]).then(() => store.close()); }
      return closing;
    },
  };
}

/**
 * Starts the cloud forum, or reports why it cannot start and returns null. The cloud forum is one
 * feature of the Discord bot: a missing or invalid observation root (CONCORDIA_ARTIFACT_ROOT on a
 * site that never received an artifact) must not stop the whole bot in its ready handler.
 */
export function tryStartCloudForum(
  input: Parameters<typeof startCloudForum>[0],
  start: typeof startCloudForum = startCloudForum,
): ReturnType<typeof startCloudForum> | null {
  try {
    return start(input);
  } catch (error) {
    input.warn(`Cloud forum disabled: ${(error as Error).message} (root=${input.root || "(unset)"}); the Discord bot keeps running`);
    return null;
  }
}
