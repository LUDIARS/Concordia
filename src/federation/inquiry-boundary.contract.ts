export default {
  post(result: string[], _model: string, settings: string): boolean {
    return result[result.indexOf("--tools") + 1] === "Read,Grep,Glob"
      && result.includes("--strict-mcp-config")
      && result[result.indexOf("--settings") + 1] === settings
      && result[result.indexOf("--disallowedTools") + 1].split(",").includes("Bash");
  },
};
