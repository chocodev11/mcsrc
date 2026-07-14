import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MinecraftReferenceService, VERSION_POLICY } from "./reference.ts";
import {
    DEFAULT_LIST_LIMIT,
    DEFAULT_MAX_LINES,
    DEFAULT_TOOL_TIMEOUT_MS,
    MAX_LIST_LIMIT,
    MAX_MAX_LINES,
    runTool,
} from "./response.ts";

const reference = new MinecraftReferenceService();

const server = new McpServer(
    {
        name: "mcsrc-reference",
        version: "0.2.0",
    },
    {
        instructions: [
            "Read-only Minecraft vanilla server-jar reference (decompiled source / bytecode).",
            VERSION_POLICY,
            "Workflow: mc_versions → mc_prepare_version (once per version) → mc_search_class → mc_list_members → mc_read_method (prefer) or mc_read_class (paginated).",
            "For version comparisons: mc_changed_classes (paginated) → mc_diff_method (prefer) or mc_diff_class.",
            "className is internal slash form (net/minecraft/...), dots are accepted and normalized.",
            "mc_behavior_context local_references are SAME-CLASS only — not jar-wide callers.",
            "Never substitute another Minecraft version after an error unless the user explicitly asks for a fallback.",
            "Keep payloads small: use limits, offsets, max_lines, and method-scoped tools.",
        ].join(" "),
    }
);

const modeSchema = z.enum(["source", "bytecode"]).default("source")
    .describe("source = Vineflower decompile (default); bytecode = disassembly for CRC-only/metadata changes");

const versionSchema = z.string().min(1).describe(
    "Exact version id from mc_versions (e.g. 26.x release id or 1.21.11_unobfuscated). Do not invent ids."
);

const classNameSchema = z.string().min(1).describe(
    "Internal class name, preferably slash-separated (net/minecraft/server/MinecraftServer). Dots are normalized to slashes."
);

const limitSchema = z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT)
    .describe(`Page size (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT})`);

const offsetSchema = z.number().int().min(0).default(0)
    .describe("Pagination offset into the full result list");

const maxLinesSchema = z.number().int().min(1).max(MAX_MAX_LINES).default(DEFAULT_MAX_LINES)
    .describe(`Max lines of text to return (default ${DEFAULT_MAX_LINES}, max ${MAX_MAX_LINES})`);

const startLineSchema = z.number().int().min(1).default(1)
    .describe("1-based line number to start reading from (for large classes)");

const annotations = {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
} as const;

server.registerTool(
    "mc_versions",
    {
        title: "List Minecraft versions",
        description:
            "List Minecraft versions available under the mcsrc version policy (paginated). " +
            "Use query/type to filter before other tools. Always resolve version ids here first.",
        inputSchema: z.object({
            query: z.string().optional().describe("Substring filter on version id or type (e.g. unobfuscated, 26.)"),
            type: z.string().optional().describe("Exact type filter: release, snapshot, unobfuscated, etc."),
            limit: limitSchema,
            offset: offsetSchema,
        }),
        annotations,
    },
    async ({ query, type, limit, offset }) => {
        return runTool("mc_versions", () => reference.listVersions({ query, type, limit, offset }), {
            timeoutMs: 60_000,
        });
    }
);

server.registerTool(
    "mc_prepare_version",
    {
        title: "Prepare / cache a Minecraft version",
        description:
            "Download and cache the server runtime jar for a version so later tools are fast. " +
            "Call once when starting work on a new version. First call can take a long time.",
        inputSchema: z.object({
            version: versionSchema,
        }),
        annotations,
    },
    async ({ version }) => {
        return runTool("mc_prepare_version", () => reference.prepareVersion(version));
    }
);

server.registerTool(
    "mc_search_class",
    {
        title: "Search Minecraft classes",
        description:
            "Search class names in one server jar. Supports simple names (ServerLevel), camel-case acronyms, " +
            "and package/path queries (net/minecraft/server or net.minecraft.server). Returns paginated slash-form names.",
        inputSchema: z.object({
            version: versionSchema,
            query: z.string().min(1).describe("Simple name, acronym, package path, or partial FQN"),
            limit: limitSchema,
            offset: offsetSchema,
        }),
        annotations,
    },
    async ({ version, query, limit, offset }) => {
        return runTool("mc_search_class", () => reference.searchClass(version, query, limit, offset));
    }
);

server.registerTool(
    "mc_list_members",
    {
        title: "List class members",
        description:
            "List declared methods/fields for a class (name, descriptor, line) without dumping the full source. " +
            "Prefer this before mc_read_class. Use results with mc_read_method.",
        inputSchema: z.object({
            version: versionSchema,
            className: classNameSchema,
            kind: z.enum(["method", "field", "all"]).default("all")
                .describe("Filter to methods, fields, or both"),
            query: z.string().optional().describe("Optional substring filter on member name or descriptor"),
            limit: limitSchema,
            offset: offsetSchema,
        }),
        annotations,
    },
    async ({ version, className, kind, query, limit, offset }) => {
        return runTool("mc_list_members", () =>
            reference.listMembers(version, className, { kind, query, limit, offset })
        );
    }
);

server.registerTool(
    "mc_read_class",
    {
        title: "Read Minecraft class",
        description:
            "Read decompiled source or bytecode for a whole class. Results are line-truncated by default to protect context. " +
            "Prefer mc_list_members + mc_read_method for targeted work. Use start_line/max_lines to page through large classes.",
        inputSchema: z.object({
            version: versionSchema,
            className: classNameSchema,
            mode: modeSchema,
            start_line: startLineSchema,
            max_lines: maxLinesSchema,
        }),
        annotations,
    },
    async ({ version, className, mode, start_line, max_lines }) => {
        return runTool("mc_read_class", () =>
            reference.readClass(version, className, mode, { startLine: start_line, maxLines: max_lines })
        );
    }
);

server.registerTool(
    "mc_read_method",
    {
        title: "Read Minecraft method",
        description:
            "Read one method body (decompiled source or bytecode). Preferred over mc_read_class. " +
            "Pass descriptor when overloaded; constructors are <init>. Use mc_list_members if the method is not found.",
        inputSchema: z.object({
            version: versionSchema,
            className: classNameSchema,
            memberName: z.string().min(1).describe("Method name, e.g. tick or <init>"),
            descriptor: z.string().optional().describe("JVM descriptor to disambiguate overloads, e.g. (Lnet/minecraft/world/level/Level;)V"),
            mode: modeSchema,
        }),
        annotations,
    },
    async ({ version, className, memberName, descriptor, mode }) => {
        return runTool("mc_read_method", () =>
            reference.readMethod(version, className, memberName, descriptor, mode)
        );
    }
);

server.registerTool(
    "mc_changed_classes",
    {
        title: "Changed Minecraft classes",
        description:
            "List classes that changed between two versions using class CRCs (paginated). " +
            "Returns summary counts plus one page of class names. Always pass limit; use query to focus on a package.",
        inputSchema: z.object({
            leftVersion: versionSchema.describe("Older / left version id"),
            rightVersion: versionSchema.describe("Newer / right version id"),
            query: z.string().optional().describe("Optional substring filter on class name (e.g. world/level)"),
            hideSameSize: z.boolean().default(false)
                .describe("If true, hide modifications where total uncompressed size is unchanged"),
            limit: limitSchema,
            offset: offsetSchema,
        }),
        annotations,
    },
    async ({ leftVersion, rightVersion, query, hideSameSize, limit, offset }) => {
        return runTool("mc_changed_classes", () =>
            reference.getChangedClasses(leftVersion, rightVersion, query, hideSameSize, limit, offset)
        );
    }
);

server.registerTool(
    "mc_diff_class",
    {
        title: "Diff Minecraft class",
        description:
            "Unified diff for one class between two versions. Diff text is line-capped. " +
            "If source is identical but CRC changed, try mode=bytecode. Prefer mc_diff_method for single methods.",
        inputSchema: z.object({
            leftVersion: versionSchema,
            rightVersion: versionSchema,
            className: classNameSchema,
            mode: modeSchema,
            max_lines: z.number().int().min(1).max(MAX_MAX_LINES).default(400)
                .describe("Max lines of unified diff to return"),
        }),
        annotations,
    },
    async ({ leftVersion, rightVersion, className, mode, max_lines }) => {
        return runTool("mc_diff_class", () =>
            reference.diffClass(leftVersion, rightVersion, className, mode, { maxLines: max_lines })
        );
    }
);

server.registerTool(
    "mc_diff_method",
    {
        title: "Diff Minecraft method",
        description:
            "Unified diff for a single method between two versions. Preferred over full-class diffs for behavior reviews.",
        inputSchema: z.object({
            leftVersion: versionSchema,
            rightVersion: versionSchema,
            className: classNameSchema,
            memberName: z.string().min(1).describe("Method name"),
            descriptor: z.string().optional().describe("JVM descriptor when overloaded"),
            mode: modeSchema,
        }),
        annotations,
    },
    async ({ leftVersion, rightVersion, className, memberName, descriptor, mode }) => {
        return runTool("mc_diff_method", () =>
            reference.diffMethod(leftVersion, rightVersion, className, memberName, descriptor, mode)
        );
    }
);

server.registerTool(
    "mc_behavior_context",
    {
        title: "Minecraft behavior context",
        description:
            "Review-oriented snippet for a class or member. " +
            "include_local_refs only finds references inside the SAME class — not jar-wide callers. " +
            "Jar-wide find-usages is not available yet.",
        inputSchema: z.object({
            version: versionSchema,
            className: classNameSchema,
            memberName: z.string().optional().describe("Optional method/field name to focus the snippet"),
            descriptor: z.string().optional().describe("Optional JVM descriptor"),
            include_local_refs: z.boolean().default(false)
                .describe("If true, include same-class reference sites only (NOT jar-wide callers)"),
        }),
        annotations,
    },
    async ({ version, className, memberName, descriptor, include_local_refs }) => {
        return runTool("mc_behavior_context", () =>
            reference.getBehaviorContext(version, className, memberName, descriptor, include_local_refs)
        );
    }
);

// Keep a short stderr banner so hosts show the process is alive (never stdout — stdio MCP).
console.error(
    `[mcsrc-mcp] ready (timeout default ${DEFAULT_TOOL_TIMEOUT_MS / 1000}s). ` +
    "Cache dir: " + (process.env.MCSRC_CACHE_DIR ?? ".mcsrc-cache")
);

const transport = new StdioServerTransport();
await server.connect(transport);
