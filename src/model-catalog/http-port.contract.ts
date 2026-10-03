/** Cc-side structural async port contract; Lapilli consumption is a later boundary. */
export default {post(result: unknown): boolean {
  return !!result && typeof result === "object" && typeof (result as {resolve?:unknown}).resolve === "function";
}};
