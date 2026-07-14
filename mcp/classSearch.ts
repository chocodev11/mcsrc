import { getCamelCaseAcronym, matchesCamelCase, performSearch } from "../src/logic/Search.ts";

/**
 * Class search for MCP: supports simple names (existing UI ranking) and
 * package / slash / dotted path queries.
 */
export function searchClasses(query: string, classes: string[], limit = 100): string[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
        return [];
    }

    // Path-like queries: match full internal name (slash or dotted).
    if (trimmed.includes("/") || trimmed.includes(".")) {
        return searchByPath(trimmed, classes, limit);
    }

    return performSearch(trimmed, classes).slice(0, limit);
}

function searchByPath(query: string, classes: string[], limit: number): string[] {
    const normalized = query.replace(/\./g, "/").replace(/\\/g, "/").toLowerCase();
    const withoutClass = normalized.replace(/\.class$/, "");

    const scored = classes
        .map(className => {
            const lower = className.toLowerCase();
            let score = -1;
            if (lower === withoutClass) {
                score = 0;
            } else if (lower.startsWith(withoutClass)) {
                score = 1;
            } else if (lower.includes(withoutClass)) {
                score = 2 + lower.indexOf(withoutClass);
            } else {
                // Also allow simple-name fallback when path query is only a suffix.
                const simple = className.split("/").pop() ?? className;
                const simpleQuery = withoutClass.split("/").pop() ?? withoutClass;
                if (simple.toLowerCase().includes(simpleQuery)) {
                    score = 100 + simple.toLowerCase().indexOf(simpleQuery);
                } else if (matchesCamelCase(simple, simpleQuery)) {
                    score = 200;
                } else if (getCamelCaseAcronym(simple).toLowerCase().startsWith(simpleQuery.toLowerCase())) {
                    score = 201;
                }
            }
            return { className, score };
        })
        .filter(entry => entry.score >= 0)
        .sort((a, b) => {
            if (a.score !== b.score) {
                return a.score - b.score;
            }
            return a.className.localeCompare(b.className);
        })
        .slice(0, limit)
        .map(entry => entry.className);

    return scored;
}
