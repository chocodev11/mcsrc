import type { ChangeState, EntryInfo } from "./types.ts";

const CONTEXT_LINES = 3;
const MAX_EXACT_DIFF_CELLS = 1_000_000;

export function getChangedEntries(
    leftEntries: Map<string, EntryInfo>,
    rightEntries: Map<string, EntryInfo>,
    hideSameSize = false
): Map<string, Exclude<ChangeState, "unchanged">> {
    const changes = new Map<string, Exclude<ChangeState, "unchanged">>();
    const allKeys = new Set<string>([...leftEntries.keys(), ...rightEntries.keys()]);

    for (const key of allKeys) {
        const leftInfo = leftEntries.get(key);
        const rightInfo = rightEntries.get(key);

        if (!leftInfo) {
            changes.set(key, "added");
            continue;
        }

        if (!rightInfo) {
            changes.set(key, "deleted");
            continue;
        }

        const hasChanges = leftInfo.classCrcs.size !== rightInfo.classCrcs.size ||
            [...leftInfo.classCrcs.entries()].some(([className, leftCrc]) => rightInfo.classCrcs.get(className) !== leftCrc);

        if (!hasChanges) {
            continue;
        }

        if (hideSameSize && leftInfo.totalUncompressedSize === rightInfo.totalUncompressedSize) {
            continue;
        }

        changes.set(key, "modified");
    }

    return changes;
}

export function createUnifiedDiff(leftName: string, rightName: string, leftText: string, rightText: string): string {
    if (leftText === rightText) {
        return "";
    }

    const leftLines = splitLines(leftText);
    const rightLines = splitLines(rightText);
    const prefixLength = getCommonPrefixLength(leftLines, rightLines);
    const suffixLength = getCommonSuffixLength(leftLines, rightLines, prefixLength);
    const leftCore = leftLines.slice(prefixLength, leftLines.length - suffixLength);
    const rightCore = rightLines.slice(prefixLength, rightLines.length - suffixLength);
    const beforeContext = leftLines.slice(Math.max(0, prefixLength - CONTEXT_LINES), prefixLength);
    const afterContext = leftLines.slice(leftLines.length - suffixLength, Math.min(leftLines.length, leftLines.length - suffixLength + CONTEXT_LINES));
    const lines = [`--- ${leftName}`, `+++ ${rightName}`];

    for (const line of beforeContext) {
        lines.push(` ${line}`);
    }

    if (leftCore.length * rightCore.length > MAX_EXACT_DIFF_CELLS) {
        for (const line of leftCore) {
            lines.push(`-${line}`);
        }
        for (const line of rightCore) {
            lines.push(`+${line}`);
        }
    } else {
        for (const part of diffLines(leftCore, rightCore)) {
            lines.push(`${part.type}${part.line}`);
        }
    }

    for (const line of afterContext) {
        lines.push(` ${line}`);
    }

    return lines.join("\n");
}

function splitLines(text: string): string[] {
    return text.length === 0 ? [] : text.split(/\r?\n/);
}

function getCommonPrefixLength(left: string[], right: string[]): number {
    const max = Math.min(left.length, right.length);
    let index = 0;
    while (index < max && left[index] === right[index]) {
        index++;
    }
    return index;
}

function getCommonSuffixLength(left: string[], right: string[], prefixLength: number): number {
    const max = Math.min(left.length, right.length) - prefixLength;
    let count = 0;
    while (count < max && left[left.length - 1 - count] === right[right.length - 1 - count]) {
        count++;
    }
    return count;
}

function diffLines(left: string[], right: string[]): { type: " " | "-" | "+"; line: string; }[] {
    const matrix: number[][] = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));

    for (let i = left.length - 1; i >= 0; i--) {
        for (let j = right.length - 1; j >= 0; j--) {
            matrix[i][j] = left[i] === right[j]
                ? matrix[i + 1][j + 1] + 1
                : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
        }
    }

    const result: { type: " " | "-" | "+"; line: string; }[] = [];
    let i = 0;
    let j = 0;

    while (i < left.length && j < right.length) {
        if (left[i] === right[j]) {
            result.push({ type: " ", line: left[i] });
            i++;
            j++;
        } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
            result.push({ type: "-", line: left[i] });
            i++;
        } else {
            result.push({ type: "+", line: right[j] });
            j++;
        }
    }

    while (i < left.length) {
        result.push({ type: "-", line: left[i] });
        i++;
    }

    while (j < right.length) {
        result.push({ type: "+", line: right[j] });
        j++;
    }

    return result;
}
