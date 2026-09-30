/** @implements spec/feature/discord-session-task-post.md §3.6 — Cc 由来 inject 1 行通知の observe 契約 */
/** Reuse the repository's observe-only contract runtime at this domain boundary. */
export { contract } from "../harness/reliability/ontime-runtime.js";
