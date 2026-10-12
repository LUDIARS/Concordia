/** reaper-node-only-C-1 observation predicate for classifyKind. */
const NODE = new Set(["node", "node.exe", "nodejs"]);
function head(cmd: string): string {
  const t = cmd.trimStart();
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1);
    return end < 0 ? t.slice(1) : t.slice(1, end);
  }
  return t.match(/^\S+/)?.[0] ?? "";
}
function isNode(path: string): boolean {
  return NODE.has((path.split(/[\/]/).pop() ?? "").toLowerCase());
}
export default {
  post(result: string | null, cmd: string, imageName?: string | null): boolean {
    if (result === null) return true;
    return isNode(head(cmd)) && (!imageName || isNode(imageName));
  },
};
