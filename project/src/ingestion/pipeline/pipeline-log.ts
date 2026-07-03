/**
 * The pipeline's logging seam: entrypoints bind it to pino. Callers log stage
 * events and verdict COUNTS only — never memory content, claims, spans or
 * tokens (CLAUDE.md logging rule).
 */
export type PipelineLog = (event: Record<string, unknown>, message: string) => void;

export const noopLog: PipelineLog = () => undefined;
