import type { LibrarySource, Suggestion } from "./types.js";
export interface AnalysisRunnerResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}
export type AnalysisRunner = (prompt: string, opts: {
    model?: string;
    timeoutMs?: number;
}) => Promise<AnalysisRunnerResult>;
export interface AnalyzeHomeOptions {
    disabled?: boolean;
    model?: string;
    timeoutMs?: number;
    runner?: AnalysisRunner;
}
export interface AnalyzeResult {
    disabled: boolean;
    model: string;
    suggestions: Suggestion[];
    error?: string;
}
export declare function analyzeHome(source: LibrarySource, opts?: AnalyzeHomeOptions): Promise<AnalyzeResult>;
export declare function extractJson(text: string): unknown | null;
