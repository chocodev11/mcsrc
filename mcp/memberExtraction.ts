import type { MemberToken } from "../src/logic/Tokens.ts";

export function extractMemberSnippet(source: string, token: MemberToken): string {
    const lineStart = source.lastIndexOf("\n", token.start) + 1;
    const delimiter = findCodeDelimiter(source, token.start);

    if (!delimiter || delimiter.char === ";") {
        const lineEnd = source.indexOf("\n", token.start);
        return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    }

    const blockEnd = findBlockEnd(source, delimiter.index);
    return source.slice(lineStart, blockEnd === -1 ? source.length : blockEnd + 1);
}

function findCodeDelimiter(source: string, start: number): { index: number; char: "{" | ";" } | undefined {
    for (const index of codeCharacterIndexes(source, start)) {
        const char = source[index];
        if (char === "{" || char === ";") {
            return { index, char };
        }
    }
    return undefined;
}

export function findBlockEnd(source: string, openBrace: number): number {
    let depth = 0;
    for (const index of codeCharacterIndexes(source, openBrace)) {
        if (source[index] === "{") {
            depth++;
        } else if (source[index] === "}") {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function* codeCharacterIndexes(source: string, start: number): Generator<number> {
    let state: "code" | "string" | "char" | "textBlock" | "lineComment" | "blockComment" = "code";

    for (let index = start; index < source.length; index++) {
        const char = source[index];
        const next = source[index + 1];

        if (state === "lineComment") {
            if (char === "\n") state = "code";
            continue;
        }
        if (state === "blockComment") {
            if (char === "*" && next === "/") {
                state = "code";
                index++;
            }
            continue;
        }
        if (state === "textBlock") {
            if (source.startsWith('"""', index)) {
                state = "code";
                index += 2;
            }
            continue;
        }
        if (state === "string" || state === "char") {
            if (char === "\\") {
                index++;
            } else if ((state === "string" && char === '"') || (state === "char" && char === "'")) {
                state = "code";
            }
            continue;
        }

        if (char === "/" && next === "/") {
            state = "lineComment";
            index++;
        } else if (char === "/" && next === "*") {
            state = "blockComment";
            index++;
        } else if (source.startsWith('"""', index)) {
            state = "textBlock";
            index += 2;
        } else if (char === '"') {
            state = "string";
        } else if (char === "'") {
            state = "char";
        } else {
            yield index;
        }
    }
}
