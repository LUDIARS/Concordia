/** @implements SPEC-CONSULT-DRIVE-TRANSFER */
/**
 * C-1: a transfer file is accepted only when its name part is a usable file name, its extension is a 3D model
 * or an audio format, and its known size is at most 200 MB; the accepted name never contains a path separator.
 */
const MODEL = new Set([".fbx", ".obj", ".glb", ".gltf", ".blend", ".vrm", ".stl", ".dae", ".3ds", ".usdz", ".usd", ".ply", ".abc", ".max", ".ma", ".mb"]);
const AUDIO = new Set([".wav", ".mp3", ".ogg", ".flac", ".aif", ".aiff", ".m4a", ".opus"]);
const MAX = 200 * 1024 * 1024;

export default {
  post(result: unknown, input: unknown): boolean {
    if (!result || typeof result !== "object") return false;
    const decision = result as { ok?: unknown; kind?: unknown; fileName?: unknown };
    const size = (input as { size?: unknown } | null)?.size;
    if (decision.ok !== true) return true;
    if (typeof decision.fileName !== "string" || /[\/]/.test(decision.fileName)) return false;
    const dot = decision.fileName.lastIndexOf(".");
    const ext = dot > 0 ? decision.fileName.slice(dot).toLowerCase() : "";
    const kindOk = (decision.kind === "model" && MODEL.has(ext)) || (decision.kind === "audio" && AUDIO.has(ext));
    const sizeOk = size === null || (typeof size === "number" && size >= 0 && size <= MAX);
    return kindOk && sizeOk;
  },
};
