import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MinecraftReferenceService, resolveCacheDir, VERSION_POLICY } from "./reference.ts";
import {
    DEFAULT_DIFF_MAX_LINES,
    DEFAULT_LIST_LIMIT,
    DEFAULT_MAX_LINES,
    DEFAULT_METHOD_MAX_LINES,
    DEFAULT_TOOL_TIMEOUT_MS,
    MAX_LIST_LIMIT,
    MAX_MAX_LINES,
    runTool,
} from "./response.ts";

const reference = new MinecraftReferenceService();

const server = new McpServer(
    {
        name: "mcsrc-mcp-server",
        version: "0.3.0",
    },
    {
        instructions: [
            "Read-only Minecraft vanilla server-jar reference (decompiled source / bytecode).",
            VERSION_POLICY,
            "Flow: mc_versions → mc_prepare_version (once per version) → mc_search_class → mc_list_members → mc_read_method (prefer) or mc_read_class.",
            "Compare: mc_changed_classes → mc_diff_method (prefer) or mc_diff_class.",
            "className is slash form (net/minecraft/...); dots are normalized.",
            "status=ambiguous → re-call with a descriptor from candidates; never guess overloads.",
            "Never substitute another version after an error unless the user asks.",
            "Keep payloads small: methods over classes; use limit/offset/max_lines.",
        ].join(" "),
    }
);

// Descriptions stay short: defaults/bounds are already in the JSON schema, so repeating
// them in prose only inflates the per-request tool listing.
const modeSchema = z.enum(["source", "bytecode"]).default("source")
    .describe("source = decompile; bytecode = disassembly, for CRC-only/metadata changes");

const versionSchema = z.string().min(1).describe("Version id from mc_versions. Do not invent ids.");

const classNameSchema = z.string().min(1)
    .describe("Slash form: net/minecraft/server/MinecraftServer (dots normalized)");

const limitSchema = z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT)
    .describe("Page size");

const offsetSchema = z.number().int().min(0).default(0).describe("Pagination offset");

const maxLinesSchema = z.number().int().min(1).max(MAX_MAX_LINES).default(DEFAULT_MAX_LINES)
    .describe("Max lines returned");

const methodMaxLinesSchema = z.number().int().min(1).max(MAX_MAX_LINES).default(DEFAULT_METHOD_MAX_LINES)
    .describe("Max lines of method body");

const diffMaxLinesSchema = z.number().int().min(1).max(MAX_MAX_LINES).default(DEFAULT_DIFF_MAX_LINES)
    .describe("Max diff lines");

const startLineSchema = z.number().int().min(1).default(1).describe("1-based start line");

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
            "List available Minecraft versions (paginated). Always resolve version ids here first.",
        inputSchema: z.object({
            query: z.string().optional().describe("Substring filter on id or type"),
            type: z.string().optional().describe("Exact type: release, snapshot, unobfuscated, ..."),
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
            "Download and cache a version's server jar so later tools are fast. " +
            "Call once per version; the first call can take minutes.",
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
            "Search class names in one jar by simple name (ServerLevel), camel-case acronym, or package path. " +
            "Returns paginated slash-form names. total_capped=true means results are incomplete — narrow the query.",
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
            "List a class's methods/fields (name, descriptor, line) without dumping source. " +
            "Use before mc_read_class; feed the descriptor to mc_read_method when overloaded.",
        inputSchema: z.object({
            version: versionSchema,
            className: classNameSchema,
            kind: z.enum(["method", "field", "all"]).default("all"),
            query: z.string().optional().describe("Substring filter on member name or descriptor"),
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
            "Read a whole class as decompiled source or bytecode (line-capped). " +
            "Prefer mc_list_members + mc_read_method; page large classes with start_line/max_lines.",
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
            "Read one method body (source or bytecode). Preferred over mc_read_class. " +
            "status=ambiguous → re-call with a descriptor from candidates; mc_list_members if it is missing.",
        inputSchema: z.object({
            version: versionSchema,
            className: classNameSchema,
            memberName: z.string().min(1).describe("Method name; <init> for constructors"),
            descriptor: z.string().optional().describe("JVM descriptor for overloads, e.g. (Lnet/minecraft/world/level/Level;)V"),
            mode: modeSchema,
            max_lines: methodMaxLinesSchema,
        }),
        annotations,
    },
    async ({ version, className, memberName, descriptor, mode, max_lines }) => {
        return runTool("mc_read_method", () =>
            reference.readMethod(version, className, memberName, descriptor, mode, { maxLines: max_lines })
        );
    }
);

server.registerTool(
    "mc_changed_classes",
    {
        title: "Changed Minecraft classes",
        description:
            "List classes that changed between two versions by CRC (paginated). " +
            "Returns summary counts plus one page of names; use query to focus one package.",
        inputSchema: z.object({
            leftVersion: versionSchema.describe("Older version id"),
            rightVersion: versionSchema.describe("Newer version id"),
            query: z.string().optional().describe("Substring filter on class name, e.g. world/level"),
            hideSameSize: z.boolean().default(false)
                .describe("Hide modifications where uncompressed size is unchanged"),
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
            "Unified diff of one class between two versions (line-capped). " +
            "Source identical but CRC changed → try mode=bytecode. Prefer mc_diff_method.",
        inputSchema: z.object({
            leftVersion: versionSchema,
            rightVersion: versionSchema,
            className: classNameSchema,
            mode: modeSchema,
            max_lines: diffMaxLinesSchema,
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
            "Unified diff of one method between two versions (line-capped). " +
            "Preferred over full-class diffs. Pass descriptor when overloaded.",
        inputSchema: z.object({
            leftVersion: versionSchema,
            rightVersion: versionSchema,
            className: classNameSchema,
            memberName: z.string().min(1).describe("Method name"),
            descriptor: z.string().optional().describe("JVM descriptor when overloaded"),
            mode: modeSchema,
            max_lines: diffMaxLinesSchema,
        }),
        annotations,
    },
    async ({ leftVersion, rightVersion, className, memberName, descriptor, mode, max_lines }) => {
        return runTool("mc_diff_method", () =>
            reference.diffMethod(leftVersion, rightVersion, className, memberName, descriptor, mode, {
                maxLines: max_lines,
            })
        );
    }
);

server.registerTool(
    "mc_behavior_context",
    {
        title: "Minecraft behavior context",
        description:
            "Class/member snippet plus optional reference sites inside the SAME class (not jar-wide callers). " +
            "Prefer mc_read_method unless you need those refs.",
        inputSchema: z.object({
            version: versionSchema,
            className: classNameSchema,
            memberName: z.string().optional().describe("Method/field name to focus the snippet"),
            descriptor: z.string().optional().describe("JVM descriptor"),
            include_local_refs: z.boolean().default(false)
                .describe("Include same-class reference sites (NOT jar-wide callers)"),
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
// Cache lives outside the open repo cwd by default (user cache dir); override with MCSRC_CACHE_DIR.
console.error(
    `[mcsrc-mcp] ready (timeout default ${DEFAULT_TOOL_TIMEOUT_MS / 1000}s). ` +
    "Cache dir: " + resolveCacheDir()
);

const transport = new StdioServerTransport();
await server.connect(transport);
