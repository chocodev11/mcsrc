/** Shared MCP response helpers: size limits, pagination, timeouts, agent-friendly errors. */

export const DEFAULT_LIST_LIMIT = 30;
export const MAX_LIST_LIMIT = 100;
/** Default line page for full-class reads (keep agent context small). */
export const DEFAULT_MAX_LINES = 100;
export const MAX_MAX_LINES = 1000;
/** Default line cap for single-method bodies. */
export const DEFAULT_METHOD_MAX_LINES = 120;
/** Default line cap for unified diffs. */
export const DEFAULT_DIFF_MAX_LINES = 200;
/** Hard ceiling on tool result text size. */
export const MAX_RESPONSE_CHARS = 28_000;
/** Max ranked search hits before total_count is reported as capped. */
export const SEARCH_MATCH_CAP = 500;
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
            content: `// start_line ${startLine} past end (${totalLines} lines)`,
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
    // Line numbers live in the `lines=` meta header; the note only carries the next action.
    const note = truncated ? "truncated; use start_line/max_lines or mc_read_method" : undefined;

    let content = slice.join("\n");
    if (truncated) {
        content = `${content}\n// ... ${note}`;
    }

    return {
        content,
        truncation: {
            truncated,
            total_lines: totalLines,
            start_line: startLine,
            returned_lines: slice.length,
            max_lines: maxLines,
            note,
        },
    };
}

export function enforceCharBudget(text: string, budget = MAX_RESPONSE_CHARS): { text: string; truncated: boolean } {
    if (text.length <= budget) {
        return { text, truncated: false };
    }
    const kept = text.slice(0, budget);
    return {
        text: `${kept}\n// ... truncated at ${budget} chars; narrow scope (method/member/pagination)`,
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
                "First use downloads the jar. Retry, call mc_prepare_version, or use mc_read_method."
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
    const steps = nextSteps.length > 0 ? ` → ${nextSteps.join("; ")}` : "";
    return `${field} empty: ${reason}${steps}`;
}

const BODY_KEYS = ["content", "diff", "snippet"] as const;

/**
 * Format tool results for model context — everything is plain text, never JSON:
 * - scalar fields collapse into one `key=value` header line
 * - page/truncation collapse to `page=0-29/1250 next=30` / `lines=1-100/900`
 * - list payloads become one row per line under a column header
 * - code bodies are appended raw (no escaping)
 */
export function formatToolText(value: unknown): string {
    if (typeof value !== "object" || value === null) {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return formatList("items", value);
    }

    const obj = value as Record<string, unknown>;
    const bodyKey = BODY_KEYS.find(key => {
        const body = obj[key];
        return typeof body === "string" && body.length > 0;
    });

    const header: string[] = [];
    const blocks: string[] = [];

    for (const [key, entry] of Object.entries(obj)) {
        if (key === bodyKey || entry === undefined || entry === null || entry === "") {
            continue;
        }
        if (key === "page") {
            header.push(formatPage(entry as PageMeta));
        } else if (key === "truncation") {
            header.push(formatTruncation(entry as TruncationMeta));
        } else if (Array.isArray(entry)) {
            if (entry.length > 0) {
                blocks.push(formatList(key, entry));
            }
        } else if (typeof entry === "object") {
            header.push(`${key}=${JSON.stringify(entry)}`);
        } else {
            header.push(`${key}=${String(entry)}`);
        }
    }

    const parts = [header.join(" "), ...blocks];
    if (bodyKey) {
        parts.push(obj[bodyKey] as string);
    }
    return parts.filter(part => part.length > 0).join("\n");
}

/** `page=0-29/1250 next=30` instead of six JSON fields (count/limit/has_more are derivable). */
function formatPage(page: PageMeta): string {
    if (page.count === 0) {
        return `page=0/${page.total_count}`;
    }
    const last = page.offset + page.count - 1;
    const next = page.next_offset === null ? "" : ` next=${page.next_offset}`;
    return `page=${page.offset}-${last}/${page.total_count}${next}`;
}

/** `lines=1-100/900`; the note travels in `message`. */
function formatTruncation(truncation: TruncationMeta): string {
    const end = truncation.start_line + truncation.returned_lines - 1;
    return `lines=${truncation.start_line}-${end}/${truncation.total_lines}`;
}

/** Object rows share one column header; string rows are printed bare. */
function formatList(key: string, items: readonly unknown[]): string {
    const first = items[0];
    if (typeof first !== "object" || first === null || Array.isArray(first)) {
        return `${key}:\n${items.map(item => String(item)).join("\n")}`;
    }

    const columns = Object.keys(first as Record<string, unknown>);
    const rows = items.map(item => {
        const row = item as Record<string, unknown>;
        return columns.map(column => {
            const cell = row[column];
            return cell === undefined || cell === null || cell === "" ? "-" : String(cell);
        }).join(" ");
    });
    return `${key}[${columns.join(" ")}]:\n${rows.join("\n")}`;
}

export function jsonToolResult(value: unknown, options: { isError?: boolean } = {}) {
    let text: string;
    try {
        text = formatToolText(value);
    } catch (error) {
        return {
            content: [{
                type: "text" as const,
                text: `Failed to serialize tool result: ${error instanceof Error ? error.message : String(error)}`,
            }],
            isError: true,
        };
    }

    // No structuredContent: no tool declares an outputSchema, so it would only re-ship the
    // same body a second time for hosts that inject both blocks.
    return {
        content: [{ type: "text" as const, text: enforceCharBudget(text).text }],
        ...(options.isError ? { isError: true as const } : {}),
    };
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
                tip: "Confirm version with mc_versions; prefer mc_list_members/mc_read_method; mc_prepare_version for new jars.",
            },
            { isError: true }
        );
    }
}
