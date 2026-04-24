import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MinecraftReferenceService } from "./reference.ts";

const reference = new MinecraftReferenceService();

const server = new McpServer(
    {
        name: "mcsrc-reference",
        version: "0.1.0",
    },
    {
        instructions: [
            "Use this server as a read-only Minecraft vanilla reference.",
            "Call version-aware tools before comparing implementation behavior.",
            "Never substitute another Minecraft version after a tool error unless the user explicitly asks for a fallback.",
        ].join(" "),
    }
);

const modeSchema = z.enum(["source", "bytecode"]).default("source");

server.registerTool(
    "mc_versions",
    {
        title: "List Minecraft versions",
        description: "List Minecraft versions available through the current mcsrc version policy.",
        inputSchema: z.object({}),
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
    },
    async () => {
        return toolResult(async () => {
            const versions = await reference.getVersions();
            return {
                count: versions.length,
                versions: versions.map(version => ({
                    id: version.id,
                    type: version.type,
                    releaseTime: version.releaseTime,
                })),
            };
        });
    }
);

server.registerTool(
    "mc_search_class",
    {
        title: "Search Minecraft classes",
        description: "Search class names in a specific Minecraft server jar.",
        inputSchema: z.object({
            version: z.string().min(1),
            query: z.string().min(1),
            limit: z.number().int().min(1).max(100).default(100),
        }),
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
    },
    async ({ version, query, limit }) => {
        return toolResult(async () => {
            const classes = await reference.searchClass(version, query, limit);
            return { version, query, classes };
        });
    }
);

server.registerTool(
    "mc_read_class",
    {
        title: "Read Minecraft class",
        description: "Read decompiled source or bytecode for a class in a specific Minecraft version.",
        inputSchema: z.object({
            version: z.string().min(1),
            className: z.string().min(1),
            mode: modeSchema,
        }),
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
    },
    async ({ version, className, mode }) => {
        return toolResult(() => reference.readClass(version, className, mode));
    }
);

server.registerTool(
    "mc_read_method",
    {
        title: "Read Minecraft method",
        description: "Read decompiled source or bytecode for a method in a specific Minecraft version.",
        inputSchema: z.object({
            version: z.string().min(1),
            className: z.string().min(1),
            memberName: z.string().min(1),
            descriptor: z.string().optional(),
            mode: modeSchema,
        }),
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
    },
    async ({ version, className, memberName, descriptor, mode }) => {
        return toolResult(() => reference.readMethod(version, className, memberName, descriptor, mode));
    }
);

server.registerTool(
    "mc_changed_classes",
    {
        title: "Changed Minecraft classes",
        description: "List classes that changed between two Minecraft versions using class CRCs.",
        inputSchema: z.object({
            leftVersion: z.string().min(1),
            rightVersion: z.string().min(1),
            query: z.string().optional(),
            hideSameSize: z.boolean().default(false),
        }),
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
    },
    async ({ leftVersion, rightVersion, query, hideSameSize }) => {
        return toolResult(() => reference.getChangedClasses(leftVersion, rightVersion, query, hideSameSize));
    }
);

server.registerTool(
    "mc_diff_class",
    {
        title: "Diff Minecraft class",
        description: "Create a unified diff for one class between two Minecraft versions.",
        inputSchema: z.object({
            leftVersion: z.string().min(1),
            rightVersion: z.string().min(1),
            className: z.string().min(1),
            mode: modeSchema,
        }),
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
    },
    async ({ leftVersion, rightVersion, className, mode }) => {
        return toolResult(() => reference.diffClass(leftVersion, rightVersion, className, mode));
    }
);

server.registerTool(
    "mc_behavior_context",
    {
        title: "Minecraft behavior context",
        description: "Return review-oriented vanilla context for a class or member in one Minecraft version.",
        inputSchema: z.object({
            version: z.string().min(1),
            className: z.string().min(1),
            memberName: z.string().optional(),
            descriptor: z.string().optional(),
            includeCallers: z.boolean().default(false),
        }),
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
    },
    async ({ version, className, memberName, descriptor, includeCallers }) => {
        return toolResult(() => reference.getBehaviorContext(version, className, memberName, descriptor, includeCallers));
    }
);

async function toolResult<T>(callback: () => Promise<T>) {
    try {
        return jsonResult(await callback());
    } catch (error) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: [
                        error instanceof Error ? error.message : String(error),
                        "Do not substitute another Minecraft version unless the user explicitly requested a fallback.",
                    ].join("\n"),
                },
            ],
            isError: true,
        };
    }
}

function jsonResult(value: unknown) {
    return {
        content: [
            {
                type: "text" as const,
                text: JSON.stringify(value, null, 2),
            },
        ],
    };
}

const transport = new StdioServerTransport();
await server.connect(transport);
