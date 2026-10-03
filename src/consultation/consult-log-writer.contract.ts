/** @implements SPEC-CONSULT-LOG */
/**
 * C-5: a log target exists only for a consult-department session whose working folder is inside the consult
 * workspace root; otherwise null.
 */
export default {
  post(result: unknown, input: unknown): boolean {
    if (!input || typeof input !== "object") return result === null;
    const { isConsultDepartment, workspaceRoot, session } = input as {
      isConsultDepartment?: unknown; workspaceRoot?: unknown; session?: { repo_path?: unknown } | null;
    };
    const slash = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    const inside = typeof workspaceRoot === "string" && workspaceRoot.trim() !== ""
      && typeof session?.repo_path === "string"
      && slash(session.repo_path).startsWith(`${slash(workspaceRoot)}/`);
    if (isConsultDepartment !== true || !inside) return result === null;
    if (!result || typeof result !== "object") return false;
    const filePath = (result as { filePath?: unknown }).filePath;
    return typeof filePath === "string" && slash(filePath).startsWith(`${slash(session!.repo_path as string)}/`);
  },
};
