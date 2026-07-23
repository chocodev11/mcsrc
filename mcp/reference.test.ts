import { describe, expect, it } from "vitest";
import { searchClasses } from "./classSearch.ts";
import { createUnifiedDiff, getChangedEntries } from "./diff.ts";
import {
    clampLimit,
    emptyFieldMessage,
    enforceCharBudget,
    formatToolText,
    jsonToolResult,
    paginate,
    SEARCH_MATCH_CAP,
    sliceLines,
    withTimeout,
} from "./response.ts";
import type { EntryInfo } from "./types.ts";

describe("MCP reference diff helpers", () => {
    it("detects added, deleted, modified, and unchanged classes", () => {
        const left = new Map<string, EntryInfo>([
            ["net/minecraft/Removed.class", entry([["net/minecraft/Removed", 1]], 10)],
            ["net/minecraft/Changed.class", entry([["net/minecraft/Changed", 2]], 20)],
            ["net/minecraft/Same.class", entry([["net/minecraft/Same", 3]], 30)],
        ]);
        const right = new Map<string, EntryInfo>([
            ["net/minecraft/Added.class", entry([["net/minecraft/Added", 4]], 10)],
            ["net/minecraft/Changed.class", entry([["net/minecraft/Changed", 5]], 21)],
            ["net/minecraft/Same.class", entry([["net/minecraft/Same", 3]], 30)],
        ]);

        expect([...getChangedEntries(left, right)]).toEqual([
            ["net/minecraft/Removed.class", "deleted"],
            ["net/minecraft/Changed.class", "modified"],
            ["net/minecraft/Added.class", "added"],
        ]);
    });

    it("treats inner class CRC changes as base class changes", () => {
        const left = new Map<string, EntryInfo>([
            ["net/minecraft/Foo.class", entry([
                ["net/minecraft/Foo", 1],
                ["net/minecraft/Foo$Inner", 2],
            ], 20)],
        ]);
        const right = new Map<string, EntryInfo>([
            ["net/minecraft/Foo.class", entry([
                ["net/minecraft/Foo", 1],
                ["net/minecraft/Foo$Inner", 3],
            ], 20)],
        ]);

        expect(getChangedEntries(left, right).get("net/minecraft/Foo.class")).toBe("modified");
        expect(getChangedEntries(left, right, true).has("net/minecraft/Foo.class")).toBe(false);
    });

    it("creates a compact unified diff", () => {
        const diff = createUnifiedDiff("left", "right", "a\nb\nc\nd\ne", "a\nb\nx\nd\ne");

        expect(diff).toContain("--- left");
        expect(diff).toContain("+++ right");
        expect(diff).toContain("-c");
        expect(diff).toContain("+x");
    });
});

describe("MCP class search", () => {
    const classes = [
        "net/minecraft/server/MinecraftServer",
        "net/minecraft/server/level/ServerLevel",
        "net/minecraft/world/level/Level",
        "net/minecraft/world/entity/Entity",
        "com/mojang/brigadier/CommandDispatcher",
    ];

    it("matches simple names", () => {
        expect(searchClasses("ServerLevel", classes)).toContain("net/minecraft/server/level/ServerLevel");
    });

    it("matches package / dotted paths", () => {
        expect(searchClasses("net/minecraft/server", classes)).toEqual(
            expect.arrayContaining([
                "net/minecraft/server/MinecraftServer",
                "net/minecraft/server/level/ServerLevel",
            ])
        );
        expect(searchClasses("net/minecraft/server", classes)).toHaveLength(2);
        expect(searchClasses("net.minecraft.world.level", classes)).toContain("net/minecraft/world/level/Level");
    });

    it("returns empty for no hits", () => {
        expect(searchClasses("DefinitelyMissing", classes)).toEqual([]);
    });

    it("respects explicit match cap for total honesty", () => {
        const many = Array.from({ length: SEARCH_MATCH_CAP + 20 }, (_, i) => `pkg/Class${i}`);
        const ranked = searchClasses("pkg/", many, SEARCH_MATCH_CAP + 1);
        expect(ranked.length).toBe(SEARCH_MATCH_CAP + 1);
        const totalCapped = ranked.length > SEARCH_MATCH_CAP;
        const candidates = totalCapped ? ranked.slice(0, SEARCH_MATCH_CAP) : ranked;
        expect(totalCapped).toBe(true);
        expect(candidates).toHaveLength(SEARCH_MATCH_CAP);
    });
});

describe("MCP response helpers", () => {
    it("paginates with has_more metadata", () => {
        const items = Array.from({ length: 10 }, (_, i) => i);
        const page1 = paginate(items, 3, 0);
        expect(page1.items).toEqual([0, 1, 2]);
        expect(page1.page.has_more).toBe(true);
        expect(page1.page.next_offset).toBe(3);
        expect(page1.page.total_count).toBe(10);

        const page2 = paginate(items, 3, 9);
        expect(page2.items).toEqual([9]);
        expect(page2.page.has_more).toBe(false);
        expect(page2.page.next_offset).toBeNull();
    });

    it("clamps limits", () => {
        expect(clampLimit(undefined)).toBe(30);
        expect(clampLimit(1000)).toBe(100);
        expect(clampLimit(0)).toBe(1);
    });

    it("slices lines and reports truncation", () => {
        const text = ["a", "b", "c", "d", "e"].join("\n");
        const sliced = sliceLines(text, { startLine: 2, maxLines: 2 });
        expect(sliced.content).toContain("b");
        expect(sliced.content).toContain("c");
        expect(sliced.truncation.truncated).toBe(true);
        expect(sliced.truncation.total_lines).toBe(5);
        expect(sliced.truncation.returned_lines).toBe(2);
    });

    it("enforces character budget", () => {
        const big = "x".repeat(1000);
        const result = enforceCharBudget(big, 100);
        expect(result.truncated).toBe(true);
        expect(result.text.length).toBeLessThan(big.length);
        expect(result.text).toContain("truncated");
    });

    it("times out slow work", async () => {
        await expect(
            withTimeout(new Promise(() => {}), 20, "slow-op")
        ).rejects.toThrow(/timed out/);
    });

    it("builds empty-field guidance", () => {
        const message = emptyFieldMessage("diff", "unchanged", ["try bytecode"]);
        expect(message).toContain("diff empty");
        expect(message).toContain("try bytecode");
    });

    it("formats code-first tool text without pretty JSON", () => {
        const text = formatToolText({
            className: "net/minecraft/Foo",
            status: "found",
            content: "class Foo {\n  void bar() {}\n}",
        });
        expect(text).toContain("className=net/minecraft/Foo");
        expect(text).toContain("class Foo {");
        expect(text).not.toContain("\\n");
        expect(text).not.toContain("  \"content\"");
    });

    it("formats list results as compact JSON", () => {
        const text = formatToolText({
            classes: ["a", "b"],
            page: { total_count: 2, count: 2, offset: 0, limit: 30, has_more: false, next_offset: null },
        });
        expect(text).toBe(JSON.stringify({
            classes: ["a", "b"],
            page: { total_count: 2, count: 2, offset: 0, limit: 30, has_more: false, next_offset: null },
        }));
        expect(text).not.toContain("\n  ");
    });

    it("jsonToolResult uses compact code-first content text", () => {
        const result = jsonToolResult({
            className: "X",
            content: "line1\nline2\nline3",
            status: "found",
        });
        const text = result.content[0].text;
        expect(text).toContain("line1");
        expect(text).toContain("status=found");
        expect(text).not.toContain('"content":');
    });
});

function entry(classCrcs: [string, number][], totalUncompressedSize: number): EntryInfo {
    return {
        classCrcs: new Map(classCrcs),
        totalUncompressedSize,
    };
}
