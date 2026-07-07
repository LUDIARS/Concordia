const VALID_KINDS = new Set([
    "contradiction",
    "merge",
    "archive",
    "shorten",
    "split",
]);
export async function analyzeHome(source, opts = {}) {
    const model = opts.model ?? "haiku";
    if (opts.disabled === true) {
        return { disabled: true, model, suggestions: [] };
    }
    const blocks = source.blocks.filter((b) => !b.flags.orphanIndex);
    if (blocks.length === 0) {
        return { disabled: false, model, suggestions: [] };
    }
    if (!opts.runner) {
        return { disabled: false, model, suggestions: [], error: "analysis_runner_required" };
    }
    const nameToId = new Map();
    for (const b of blocks)
        nameToId.set(b.name, b.id);
    const listing = blocks
        .map((b) => `- ${b.name}: ${b.title}${b.description ? ` - ${b.description}` : ""}`)
        .join("\n");
    const prompt = [
        "You are a memory and skill hygiene assistant.",
        `Review the following stored rules and memories from "${source.label}".`,
        "Suggest only high-confidence contradictions, merge candidates, archive candidates, shortening, or splitting.",
        "",
        "## Items",
        listing,
        "",
        "## Output",
        "Return exactly one JSON object and no fenced code:",
        "{",
        '  "suggestions": [',
        '    {"kind": "contradiction|merge|archive|shorten|split", "names": ["<name>", "..."], "message": "<short Japanese message>", "rationale": "<reason>"}',
        "  ]",
        "}",
        "",
        "- Use names exactly as listed.",
        "- Omit uncertain findings.",
        "- These are suggestions only; humans apply archive or edits.",
    ].join("\n");
    const r = await opts.runner(prompt, { model, timeoutMs: opts.timeoutMs });
    if (!r.ok) {
        return { disabled: false, model, suggestions: [], error: r.stderr.slice(0, 300) };
    }
    const json = extractJson(r.stdout);
    if (!json || typeof json !== "object") {
        return {
            disabled: false,
            model,
            suggestions: [],
            error: `unparsable: ${r.stdout.slice(0, 200)}`,
        };
    }
    const rawSuggestions = json.suggestions;
    const suggestions = [];
    if (Array.isArray(rawSuggestions)) {
        for (const s of rawSuggestions) {
            const parsed = normalizeSuggestion(s, nameToId);
            if (parsed)
                suggestions.push(parsed);
        }
    }
    return { disabled: false, model, suggestions };
}
export function extractJson(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            // Try fenced or embedded JSON below.
        }
    }
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    if (fence?.[1]) {
        try {
            return JSON.parse(fence[1].trim());
        }
        catch {
            // Fall through.
        }
    }
    const m = /\{[\s\S]*\}/.exec(text);
    if (m?.[0]) {
        try {
            return JSON.parse(m[0]);
        }
        catch {
            return null;
        }
    }
    return null;
}
function normalizeSuggestion(s, nameToId) {
    if (!s || typeof s !== "object")
        return null;
    const o = s;
    const kind = o.kind;
    if (!VALID_KINDS.has(kind))
        return null;
    const message = typeof o.message === "string" ? o.message.trim() : "";
    if (!message)
        return null;
    const namesRaw = o.names;
    const names = Array.isArray(namesRaw)
        ? namesRaw
        : typeof namesRaw === "string"
            ? [namesRaw]
            : [];
    const blockIds = [];
    for (const n of names) {
        if (typeof n !== "string")
            continue;
        const id = nameToId.get(n.trim());
        if (id)
            blockIds.push(id);
    }
    if (blockIds.length === 0)
        return null;
    return {
        kind,
        message,
        blockIds,
        rationale: typeof o.rationale === "string" ? o.rationale.trim() : undefined,
    };
}
