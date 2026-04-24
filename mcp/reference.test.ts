import { describe, expect, it } from "vitest";
import { createUnifiedDiff, getChangedEntries } from "./diff.ts";
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

function entry(classCrcs: [string, number][], totalUncompressedSize: number): EntryInfo {
    return {
        classCrcs: new Map(classCrcs),
        totalUncompressedSize,
    };
}
