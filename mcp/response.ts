/** Shared MCP response helpers: size limits, pagination, timeouts, agent-friendly errors. */

export const DEFAULT_LIST_LIMIT = 30;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_MAX_LINES = 200;
export const MAX_MAX_LINES = 2000;
export const MAX_RESPONSE_CHARS = 80_000;
/** Default wall-clock budget for jar/download/decompile tools. */
export const DEFAULT_TOOL_TIMEOUT_MS = 180_000;

export interface PageArgs {
    limit?: number;
    offset?: number;
}

export interface PageMeta {
    total_count: number;
    count: number;
    offset: number;
    limit: number;
    has_more: boolean;
    next_offset: number | null;
}

export interface TruncationMeta {
    truncated: boolean;
    total_lines: number;
    start_line: number;
    returned_lines: number;
    max_lines: number;
    note?: string;
}

export function clampLimit(limit: number | undefined, defaultLimit = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT): number {
    const value = limit ?? defaultLimit;
    return Math.min(Math.max(1, Math.floor(value)), max);
}

export function clampOffset(offset: number | undefined): number {
    return Math.max(0, Math.floor(offset ?? 0));
}

export function clampMaxLines(maxLines: number | undefined, defaultLines = DEFAULT_MAX_LINES): number {
    const value = maxLines ?? defaultLines;
    return Math.min(Math.max(1, Math.floor(value)), MAX_MAX_LINES);
}

export function paginate<T>(items: readonly T[], limit?: number, offset?: number): { items: T[]; page: PageMeta } {
    const safeLimit = clampLimit(limit);
    const safeOffset = clampOffset(offset);
    const slice = items.slice(safeOffset, safeOffset + safeLimit);
    const hasMore = safeOffset + slice.length < items.length;
    return {
        items: slice,
        page: {
            total_count: items.length,
            count: slice.length,
            offset: safeOffset,
            limit: safeLimit,
            has_more: hasMore,
            next_offset: hasMore ? safeOffset + slice.length : null,
        },
    };
}

export function sliceLines(
    text: string,
    options: { startLine?: number; maxLines?: number; preferMethodTool?: boolean } = {}
): { content: string; truncation: TruncationMeta } {
    const lines = text.length === 0 ? [] : text.split(/\r?\n/);
    const totalLines = lines.length;
    const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
    const maxLines = clampMaxLines(options.maxLines);
    const startIndex = startLine - 1;

    if (startIndex >= totalLines) {
        return {
            content: `// start_line ${startLine} is past end of content (${totalLines} lines).`,
            truncation: {
                truncated: true,
                total_lines: totalLines,
                start_line: startLine,
                returned_lines: 0,
                max_lines: maxLines,
                note: "start_line out of range",
            },
        };
    }

    const slice = lines.slice(startIndex, startIndex + maxLines);
    const truncated = startIndex > 0 || startIndex + slice.length < totalLines;
    const notes: string[] = [];
    if (truncated) {
        notes.push(`Showing lines ${startLine}-${startLine + slice.length - 1} of ${totalLines}.`);
        notes.push("Pass start_line/max_lines for more, or use mc_read_method / mc_list_members for smaller payloads.");
    }

    let content = slice.join("\n");
    if (truncated) {
        content = `${content}\n// ... truncated: ${notes.join(" ")}`;
    }

    return {
        content,
        truncation: {
            truncated,
            total_lines: totalLines,
            start_line: startLine,
            returned_lines: slice.length,
            max_lines: maxLines,
            note: notes.join(" ") || undefined,
        },
    };
}

export function enforceCharBudget(text: string, budget = MAX_RESPONSE_CHARS): { text: string; truncated: boolean } {
    if (text.length <= budget) {
        return { text, truncated: false };
    }
    const kept = text.slice(0, budget);
    return {
        text: `${kept}\n// ... response truncated at ${budget} characters. Use a smaller scope (method, member list, pagination).`,
        truncated: true,
    };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    if (!Number.isFinite(ms) || ms <= 0) {
        return promise;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(
                `${label} timed out after ${Math.round(ms / 1000)}s. ` +
                "First use of a version downloads the server jar (can be slow). " +
                "Retry once, call mc_prepare_version first, or narrow the request (method vs full class)."
            ));
        }, ms);
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    });
}

export function emptyFieldMessage(field: string, reason: string, nextSteps: string[]): string {
    return [
        `${field} is empty: ${reason}`,
        ...nextSteps.map(step => `- ${step}`),
    ].join("\n");
}

export function jsonToolResult(value: unknown, options: { isError?: boolean } = {}) {
    let text: string;
    try {
        text = JSON.stringify(value, null, 2) ?? "null";
    } catch (error) {
        return {
            content: [{
                type: "text" as const,
                text: `Failed to serialize tool result: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
        };
    }

    const budgeted = enforceCharBudget(text);

    // When over budget, do not attach the full object as structuredContent (client OOM / drop risk).
    let structured: Record<string, unknown>;
    let finalText = budgeted.text;
    if (budgeted.truncated) {
        structured = {
            _response_truncated: true,
            _note: `JSON exceeded ${MAX_RESPONSE_CHARS} chars. Text content is truncated; narrow the request.`,
            _preview: budgeted.text.slice(0, 2000),
        };
        finalText = budgeted.text;
    } else {
        structured = toStructured(value);
    }

    return {
        content: [{ type: "text" as const, text: finalText }],
        structuredContent: structured,
        ...(options.isError ? { isError: true as const } : {}),
    };
}

function toStructured(value: unknown): Record<string, unknown> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return { result: value };
}

export async function runTool<T>(
    label: string,
    callback: () => Promise<T>,
    options: { timeoutMs?: number } = {}
) {
    try {
        const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
        const value = await withTimeout(callback(), timeoutMs, label);
        return jsonToolResult(value);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonToolResult(
            {
                error: message,
                guidance: [
                    "Do not substitute another Minecraft version unless the user explicitly requested a fallback.",
                    "Use mc_versions (with query/type) to confirm allowed version ids.",
                    "Prefer mc_list_members / mc_read_method over full-class reads for large classes.",
                    "Call mc_prepare_version once before heavy work on a new version.",
                ],
            },
            { isError: true }
        );
    }
}
