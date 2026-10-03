/** Resolve an executable without invoking Windows npm shell shims. */
import { access } from "node:fs/promises";
import { delimiter,join,extname } from "node:path";
export async function resolveCodexModelCommand(input: {
  platform: NodeJS.Platform; path: string; explicit?: string; nodeExecutable: string;
}): Promise<{ executable:string;prefixArgs:string[] }> {
  if (input.explicit) {
    if (/\.(?:cmd|bat|ps1)$/i.test(input.explicit)) throw new Error("codex_shell_shim_not_executable");
    await access(input.explicit);
    return extname(input.explicit) === ".js" ? { executable:input.nodeExecutable,prefixArgs:[input.explicit] }
      : { executable:input.explicit,prefixArgs:[] };
  }
  const paths = input.path.split(delimiter).filter(Boolean).slice(0,100);
  for (const directory of paths) for (const file of [join(directory,input.platform === "win32" ? "codex.exe" : "codex"),
    join(directory,"node_modules","@openai","codex","bin","codex.js")]) {
    try { await access(file); }
    catch { continue; } // Candidate absence, not a fallback to an empty catalog.
    return file.endsWith(".js") ? { executable:input.nodeExecutable,prefixArgs:[file] } : { executable:file,prefixArgs:[] };
  }
  throw new Error("codex_app_server_executable_unavailable");
}
