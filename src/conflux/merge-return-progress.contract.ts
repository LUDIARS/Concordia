type Lookup = { status: string } | null;

const STATE: Record<string, string> = { pending: "waiting", acked: "running", done: "done", failed: "failed" };

export default {
  post(result: string | null, instructionId: string | null, instruction: Lookup): boolean {
    if (instructionId === null) return result === null;
    if (instruction === null) return result === "unknown";
    return result === (STATE[instruction.status] ?? "unknown");
  },
};
