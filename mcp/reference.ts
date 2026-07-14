import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vf from "@run-slicer/vf";
import { openJar, type Jar } from "../src/utils/Jar.ts";
import type { MemberToken, Token } from "../src/logic/Tokens.ts";
import { DecompileJar, type DecompileResult } from "../src/workers/decompile/types.ts";
import { searchClasses } from "./classSearch.ts";
import { createUnifiedDiff, getChangedEntries } from "./diff.ts";
import {
    emptyFieldMessage,
    paginate,
    sliceLines,
} from "./response.ts";
import { EXPERIMENTAL_VERSIONS, VERSIONS_URL } from "./versions.ts";
import type {
    BehaviorContextResult,
    ChangedClass,
    ChangedClassesResult,
    ClassMember,
    DiffClassResult,
    DiffMethodResult,
    EntryInfo,
    ListMembersResult,
    McClassReadResult,
    McMethodReadResult,
    PrepareVersionResult,
    SearchClassResult,
    VersionListEntry,
    VersionManifest,
    VersionsList,
    VersionsResult,
} from "./types.ts";

type FetchImpl = typeof fetch;
type Mode = "source" | "bytecode";

interface MinecraftJar {
    version: string;
    jar: Jar;
    blob: Blob;
}

interface ReferenceServiceOptions {
    cacheDir?: string;
    fetchImpl?: FetchImpl;
}

export const VERSION_POLICY =
    "Only Mojang versions with major >= 26 plus curated experimental/unobfuscated builds are available. " +
    "Classic 1.20/1.21 ids are not listed unless an explicit *_unobfuscated experimental entry exists. " +
    "className uses internal slash form (e.g. net/minecraft/server/MinecraftServer).";

const DEFAULT_CACHE_DIR = ".mcsrc-cache";

export class MinecraftReferenceService {
    private readonly cacheDir: string;
    private readonly fetchImpl: FetchImpl;
    private versionsPromise: Promise<VersionListEntry[]> | undefined;
    private jarPromises = new Map<string, Promise<MinecraftJar>>();
    private decompileCache = new Map<string, DecompileResult>();
    private decompileQueue: Promise<void> = Promise.resolve();

    constructor(options: ReferenceServiceOptions = {}) {
        this.cacheDir = path.resolve(options.cacheDir ?? process.env.MCSRC_CACHE_DIR ?? DEFAULT_CACHE_DIR);
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    async listVersions(options: {
        query?: string;
        type?: string;
        limit?: number;
        offset?: number;
    } = {}): Promise<VersionsResult> {
        let versions = await this.getVersions();
        if (options.type) {
            const type = options.type.toLowerCase();
            versions = versions.filter(v => v.type.toLowerCase() === type);
        }
        if (options.query) {
            const q = options.query.toLowerCase();
            versions = versions.filter(v => v.id.toLowerCase().includes(q) || v.type.toLowerCase().includes(q));
        }

        const mapped = versions.map(version => ({
            id: version.id,
            type: version.type,
            releaseTime: version.releaseTime,
        }));
        const { items, page } = paginate(mapped, options.limit, options.offset);

        return {
            count: items.length,
            versions: items,
            page,
            policy: VERSION_POLICY,
            message: items.length === 0
                ? emptyFieldMessage("versions", "no versions matched the filter", [
                    "Call mc_versions without query to list available ids",
                    "Try type=unobfuscated for experimental builds",
                    VERSION_POLICY,
                ])
                : undefined,
        };
    }

    async getVersions(): Promise<VersionListEntry[]> {
        this.versionsPromise ??= this.fetchVersions();
        return this.versionsPromise;
    }

    async prepareVersion(version: string): Promise<PrepareVersionResult> {
        const jar = await this.getJar(version);
        const classCount = getClassNames(jar.jar).length;
        return {
            version: jar.version,
            status: "ready",
            class_count: classCount,
            message: `Version ${jar.version} is cached and ready (${classCount} classes).`,
        };
    }

    async searchClass(
        version: string,
        query: string,
        limit = 30,
        offset = 0
    ): Promise<SearchClassResult> {
        const jar = await this.getJar(version);
        // Fetch a generous candidate set, then paginate for the agent.
        const candidates = searchClasses(query, getClassNames(jar.jar), Math.min(500, Math.max(limit + offset, 100)));
        const { items, page } = paginate(candidates, limit, offset);

        return {
            version,
            query,
            classes: items,
            page,
            message: items.length === 0
                ? emptyFieldMessage("classes", `no class names matched query "${query}"`, [
                    "Try a shorter simple name (e.g. ServerLevel) or a package path (net/minecraft/server)",
                    "className results use slash form, not dots",
                    "Confirm the version with mc_versions / mc_prepare_version",
                ])
                : undefined,
        };
    }

    async readClass(
        version: string,
        className: string,
        mode: Mode,
        options: { startLine?: number; maxLines?: number } = {}
    ): Promise<McClassReadResult> {
        const jar = await this.getJar(version);
        const normalizedClassName = normalizeClassName(className);
        const entry = jar.jar.entries[`${normalizedClassName}.class`];

        if (!entry) {
            return {
                version,
                className: normalizedClassName,
                mode,
                status: "missing",
                checksum: 0,
                content: `// Class not found: ${normalizedClassName}`,
                message: emptyFieldMessage("content", `class ${normalizedClassName} not found in ${version}`, [
                    "Use mc_search_class to find the internal slash name",
                    "Do not invent package prefixes",
                ]),
            };
        }

        const result = mode === "source"
            ? await this.decompileClass(jar, normalizedClassName)
            : await this.getBytecode(jar, normalizedClassName);

        const sliced = sliceLines(result.source, {
            startLine: options.startLine,
            maxLines: options.maxLines,
        });

        return {
            version,
            className: normalizedClassName,
            mode,
            status: "found",
            checksum: result.checksum,
            content: sliced.content,
            truncation: sliced.truncation,
            message: sliced.truncation.truncated
                ? sliced.truncation.note
                : undefined,
        };
    }

    async readMethod(
        version: string,
        className: string,
        memberName: string,
        descriptor: string | undefined,
        mode: Mode
    ): Promise<McMethodReadResult> {
        const jar = await this.getJar(version);
        const normalizedClassName = normalizeClassName(className);
        const methodName = memberName.trim();
        const entry = jar.jar.entries[`${normalizedClassName}.class`];

        if (!entry) {
            return {
                version,
                className: normalizedClassName,
                memberName: methodName,
                descriptor,
                mode,
                status: "missing",
                checksum: 0,
                content: `// Class not found: ${normalizedClassName}`,
                message: emptyFieldMessage("content", `class ${normalizedClassName} not found in ${version}`, [
                    "Use mc_search_class to find the internal slash name",
                ]),
            };
        }

        const content = mode === "source"
            ? await this.readSourceMethod(version, normalizedClassName, methodName, descriptor)
            : await this.readBytecodeMethod(version, normalizedClassName, methodName, descriptor);

        if (!content) {
            return {
                version,
                className: normalizedClassName,
                memberName: methodName,
                descriptor,
                mode,
                status: "missing",
                checksum: entry.crc32,
                content: `// Method not found: ${methodName}${descriptor ?? ""}`,
                message: emptyFieldMessage(
                    "content",
                    `method ${methodName}${descriptor ?? ""} not found on ${normalizedClassName}`,
                    [
                        "Call mc_list_members to see exact names and descriptors",
                        "Pass descriptor when the method is overloaded",
                        "Constructors are named <init>",
                    ]
                ),
            };
        }

        return {
            version,
            className: normalizedClassName,
            memberName: methodName,
            descriptor,
            mode,
            status: "found",
            checksum: entry.crc32,
            content,
        };
    }

    async listMembers(
        version: string,
        className: string,
        options: {
            kind?: "method" | "field" | "all";
            query?: string;
            limit?: number;
            offset?: number;
        } = {}
    ): Promise<ListMembersResult> {
        const jar = await this.getJar(version);
        const normalizedClassName = normalizeClassName(className);
        const entry = jar.jar.entries[`${normalizedClassName}.class`];

        if (!entry) {
            const emptyPage = paginate<ClassMember>([], options.limit, options.offset).page;
            return {
                version,
                className: normalizedClassName,
                status: "missing",
                checksum: 0,
                members: [],
                page: emptyPage,
                message: emptyFieldMessage("members", `class ${normalizedClassName} not found`, [
                    "Use mc_search_class first",
                ]),
            };
        }

        const decompiled = await this.decompileClass(jar, normalizedClassName);
        const kind = options.kind ?? "all";
        const query = options.query?.toLowerCase();

        const members: ClassMember[] = decompiled.tokens
            .filter((token): token is MemberToken => {
                if (!token.declaration || (token.type !== "method" && token.type !== "field")) {
                    return false;
                }
                if (kind !== "all" && token.type !== kind) {
                    return false;
                }
                if (query && !token.name.toLowerCase().includes(query) && !token.descriptor.toLowerCase().includes(query)) {
                    return false;
                }
                return true;
            })
            .map(token => ({
                kind: token.type,
                name: token.name,
                descriptor: token.descriptor,
                line: getLocation(decompiled.source, token.start).line,
                declaration: token.declaration,
            }))
            // Stable unique by kind+name+descriptor
            .filter((member, index, all) =>
                all.findIndex(other =>
                    other.kind === member.kind
                    && other.name === member.name
                    && other.descriptor === member.descriptor
                ) === index
            )
            .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));

        const { items, page } = paginate(members, options.limit, options.offset);

        return {
            version,
            className: normalizedClassName,
            status: "found",
            checksum: decompiled.checksum,
            members: items,
            page,
            message: items.length === 0
                ? emptyFieldMessage("members", "no members matched filters", [
                    "Try kind=all and drop query",
                    "Inner-class members may live on Outer$Inner class names",
                ])
                : undefined,
        };
    }

    async getChangedClasses(
        leftVersion: string,
        rightVersion: string,
        query?: string,
        hideSameSize = false,
        limit = 30,
        offset = 0
    ): Promise<ChangedClassesResult> {
        const [leftJar, rightJar] = await Promise.all([
            this.getJar(leftVersion),
            this.getJar(rightVersion),
        ]);

        const changes = getChangedEntries(
            getEntriesWithCRC(leftJar.jar),
            getEntriesWithCRC(rightJar.jar),
            hideSameSize
        );
        const lowerQuery = query?.toLowerCase();
        const classes: ChangedClass[] = [];
        const summary = { added: 0, deleted: 0, modified: 0, total_changed: 0, matched: 0 };

        for (const [classFile, state] of [...changes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            summary[state]++;
            summary.total_changed++;
            const className = classFile.replace(/\.class$/, "");
            if (lowerQuery && !className.toLowerCase().includes(lowerQuery)) {
                continue;
            }
            summary.matched++;
            classes.push({ className, state });
        }

        const { items, page } = paginate(classes, limit, offset);

        return {
            leftVersion,
            rightVersion,
            summary,
            classes: items,
            page,
            message: items.length === 0
                ? emptyFieldMessage("classes", "no changed classes in this page/filter", [
                    query ? "Relax or remove query" : "These versions may be identical at class CRC level",
                    "Increase offset only when has_more is true",
                ])
                : page.has_more
                    ? `Showing ${items.length} of ${page.total_count} matched classes. Use offset=${page.next_offset} for more.`
                    : undefined,
        };
    }

    /**
     * CRC-level status for one class (and its inner classes), without scanning the whole jar result list.
     */
    async getClassChangeStatus(
        leftVersion: string,
        rightVersion: string,
        className: string
    ): Promise<Exclude<import("./types.ts").ChangeState, never>> {
        const normalizedClassName = normalizeClassName(className);
        // Base outer class key as used by getEntriesWithCRC
        const outerBase = (() => {
            const pathName = `${normalizedClassName}.class`;
            const lastSlash = pathName.lastIndexOf("/");
            const folder = lastSlash !== -1 ? pathName.substring(0, lastSlash + 1) : "";
            const fileName = pathName.substring(folder.length);
            const baseFileName = fileName.includes("$") ? fileName.split("$")[0] : fileName.replace(".class", "");
            return `${folder}${baseFileName}.class`;
        })();

        const [leftJar, rightJar] = await Promise.all([
            this.getJar(leftVersion),
            this.getJar(rightVersion),
        ]);
        const leftEntries = getEntriesWithCRC(leftJar.jar);
        const rightEntries = getEntriesWithCRC(rightJar.jar);
        const leftInfo = leftEntries.get(outerBase);
        const rightInfo = rightEntries.get(outerBase);

        if (!leftInfo && !rightInfo) {
            return "unchanged";
        }
        if (!leftInfo) {
            return "added";
        }
        if (!rightInfo) {
            return "deleted";
        }

        const hasChanges = leftInfo.classCrcs.size !== rightInfo.classCrcs.size
            || [...leftInfo.classCrcs.entries()].some(([name, leftCrc]) => rightInfo.classCrcs.get(name) !== leftCrc);

        return hasChanges ? "modified" : "unchanged";
    }

    async diffClass(
        leftVersion: string,
        rightVersion: string,
        className: string,
        mode: Mode,
        options: { maxLines?: number } = {}
    ): Promise<DiffClassResult> {
        const normalizedClassName = normalizeClassName(className);
        const [left, right, status] = await Promise.all([
            this.readClass(leftVersion, normalizedClassName, mode, { maxLines: MAX_INTERNAL_READ_LINES }),
            this.readClass(rightVersion, normalizedClassName, mode, { maxLines: MAX_INTERNAL_READ_LINES }),
            this.getClassChangeStatus(leftVersion, rightVersion, normalizedClassName),
        ]);

        // Use full cached decompile text for accurate diffs (not the truncated tool view).
        const leftFull = left.status === "found"
            ? await this.readFullClassContent(leftVersion, normalizedClassName, mode)
            : "";
        const rightFull = right.status === "found"
            ? await this.readFullClassContent(rightVersion, normalizedClassName, mode)
            : "";

        let rawDiff = status === "unchanged"
            ? ""
            : createUnifiedDiff(
                `${leftVersion}/${normalizedClassName}.${mode}`,
                `${rightVersion}/${normalizedClassName}.${mode}`,
                leftFull,
                rightFull
            );

        let message: string | undefined;
        if (status === "unchanged") {
            message = emptyFieldMessage("diff", "class CRCs match between versions (no class-level change)", [
                "Pick a class from mc_changed_classes",
                "Or verify version ids with mc_versions",
            ]);
        } else if (rawDiff.length === 0 && status === "modified" && mode === "source") {
            rawDiff = "";
            message = emptyFieldMessage(
                "diff",
                "decompiled source is identical despite CRC change (bytecode/metadata-only)",
                ["Retry with mode=bytecode"]
            );
        } else if (rawDiff.length === 0) {
            message = emptyFieldMessage("diff", `status=${status} but textual ${mode} is identical`, [
                mode === "source" ? "Try mode=bytecode" : "Change may be non-textual (attributes only)",
            ]);
        }

        if (rawDiff.length > 0) {
            const sliced = sliceLines(rawDiff, { maxLines: options.maxLines ?? 400 });
            return {
                leftVersion,
                rightVersion,
                className: normalizedClassName,
                mode,
                status,
                diff: sliced.content,
                message: sliced.truncation.truncated
                    ? `${message ? message + "\n" : ""}${sliced.truncation.note}`
                    : message,
            };
        }

        return {
            leftVersion,
            rightVersion,
            className: normalizedClassName,
            mode,
            status,
            diff: "",
            message,
        };
    }

    async diffMethod(
        leftVersion: string,
        rightVersion: string,
        className: string,
        memberName: string,
        descriptor: string | undefined,
        mode: Mode
    ): Promise<DiffMethodResult> {
        const normalizedClassName = normalizeClassName(className);
        const methodName = memberName.trim();
        const [left, right, status] = await Promise.all([
            this.readMethod(leftVersion, normalizedClassName, methodName, descriptor, mode),
            this.readMethod(rightVersion, normalizedClassName, methodName, descriptor, mode),
            this.getClassChangeStatus(leftVersion, rightVersion, normalizedClassName),
        ]);

        const leftText = left.status === "found" ? left.content : "";
        const rightText = right.status === "found" ? right.content : "";
        let diff = "";
        let message: string | undefined;

        if (left.status === "missing" && right.status === "missing") {
            message = emptyFieldMessage("diff", "method missing on both versions", [
                "Use mc_list_members on each version",
            ]);
        } else if (leftText === rightText) {
            message = emptyFieldMessage(
                "diff",
                left.status !== right.status
                    ? `method presence differs (left=${left.status}, right=${right.status}) but text compare is empty`
                    : "method text is identical between versions",
                [
                    status === "modified" && mode === "source"
                        ? "Class CRC changed; try mode=bytecode or mc_diff_class"
                        : "No method-level textual change",
                ]
            );
            if (left.status === "missing" || right.status === "missing") {
                diff = createUnifiedDiff(
                    `${leftVersion}/${normalizedClassName}#${methodName}`,
                    `${rightVersion}/${normalizedClassName}#${methodName}`,
                    leftText,
                    rightText
                );
                message = undefined;
            }
        } else {
            diff = createUnifiedDiff(
                `${leftVersion}/${normalizedClassName}#${methodName}${descriptor ?? ""}`,
                `${rightVersion}/${normalizedClassName}#${methodName}${descriptor ?? ""}`,
                leftText,
                rightText
            );
        }

        return {
            leftVersion,
            rightVersion,
            className: normalizedClassName,
            memberName: methodName,
            descriptor,
            mode,
            status,
            leftStatus: left.status,
            rightStatus: right.status,
            diff,
            message,
        };
    }

    async getBehaviorContext(
        version: string,
        className: string,
        memberName?: string,
        descriptor?: string,
        includeLocalRefs = false
    ): Promise<BehaviorContextResult> {
        const jar = await this.getJar(version);
        const normalizedClassName = normalizeClassName(className);
        const entry = jar.jar.entries[`${normalizedClassName}.class`];
        if (!entry) {
            return {
                version,
                className: normalizedClassName,
                checksum: 0,
                memberName,
                descriptor,
                snippet: `// Class not found: ${normalizedClassName}`,
                local_references: [],
                message: emptyFieldMessage("snippet", "class not found", ["Use mc_search_class"]),
            };
        }

        const result = await this.decompileClass(jar, normalizedClassName);
        const token = memberName ? findDeclarationToken(result.tokens, memberName, descriptor) : undefined;
        const snippet = token ? extractMemberSnippet(result.source, token) : limitLines(result.source, 240);
        const local_references = includeLocalRefs && token
            ? findLocalReferences(result, token)
            : [];

        let message: string | undefined;
        if (memberName && !token) {
            message = emptyFieldMessage(
                "snippet",
                `declaration for ${memberName}${descriptor ?? ""} not found; returned class head instead`,
                ["Use mc_list_members for exact names/descriptors"]
            );
        } else if (includeLocalRefs) {
            message = local_references.length === 0
                ? emptyFieldMessage(
                    "local_references",
                    "no same-class reference sites found",
                    [
                        "These are NOT jar-wide callers — only references inside this class body",
                        "Jar-wide find-usages is not available in this MCP yet",
                    ]
                )
                : "local_references lists same-class sites only (not jar-wide callers).";
        }

        return {
            version,
            className: normalizedClassName,
            checksum: result.checksum,
            memberName,
            descriptor,
            snippet,
            local_references,
            message,
        };
    }

    private async readFullClassContent(version: string, className: string, mode: Mode): Promise<string> {
        const jar = await this.getJar(version);
        const result = mode === "source"
            ? await this.decompileClass(jar, className)
            : await this.getBytecode(jar, className);
        return result.source;
    }

    private async readSourceMethod(
        version: string,
        className: string,
        memberName: string,
        descriptor?: string
    ): Promise<string | undefined> {
        const jar = await this.getJar(version);
        const result = await this.decompileClass(jar, className);
        const token = findMethodDeclarationToken(result.tokens, memberName, descriptor);
        return token ? extractMemberSnippet(result.source, token) : undefined;
    }

    private async readBytecodeMethod(
        version: string,
        className: string,
        memberName: string,
        descriptor?: string
    ): Promise<string | undefined> {
        const jar = await this.getJar(version);
        const result = await this.getBytecode(jar, className);
        return extractBytecodeMethodSnippet(result.source, memberName, descriptor);
    }

    private async fetchVersions(): Promise<VersionListEntry[]> {
        const mojang = await this.getJson<VersionsList>(VERSIONS_URL);
        const filteredMojangVersions = mojang.versions.filter(v => {
            const match = v.id.match(/^(\d+)\.(\d+)/);
            if (!match) return false;
            const major = parseInt(match[1], 10);
            return major >= 26;
        });

        return filteredMojangVersions
            .concat(EXPERIMENTAL_VERSIONS.versions)
            .sort((a, b) => b.releaseTime.localeCompare(a.releaseTime));
    }

    private async getJson<T>(url: string): Promise<T> {
        const response = await this.fetchImpl(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch JSON from ${url}: ${response.status} ${response.statusText}`);
        }
        return await response.json() as T;
    }

    private async getJar(versionId: string): Promise<MinecraftJar> {
        let promise = this.jarPromises.get(versionId);
        if (!promise) {
            promise = this.loadJar(versionId).catch(error => {
                this.jarPromises.delete(versionId);
                throw error;
            });
            this.jarPromises.set(versionId, promise);
        }
        return await promise;
    }

    private async loadJar(versionId: string): Promise<MinecraftJar> {
        const runtimeJarPath = path.join(this.cacheDir, "jars", `${safeFileName(versionId)}.jar`);
        const cachedRuntimeJar = await readOptionalFile(runtimeJarPath);
        if (cachedRuntimeJar) {
            const blob = new Blob([Uint8Array.from(cachedRuntimeJar)], { type: "application/java-archive" });
            return { version: versionId, jar: await openJar(versionId, blob), blob };
        }

        const version = await this.resolveVersionEntry(versionId);

        const manifest = await this.getJson<VersionManifest>(version.url);
        const serverDownload = manifest.downloads.server;
        if (!serverDownload?.url) {
            throw new Error(`No server jar download URL found for version: ${versionId}`);
        }

        // Log progress to stderr only (stdout is reserved for MCP stdio framing).
        console.error(`[mcsrc-mcp] Downloading server jar for ${versionId}…`);
        const serverJarBuffer = await this.cachedDownload(
            serverDownload.url,
            path.join(this.cacheDir, "downloads", `${safeFileName(versionId)}-server.jar`),
            serverDownload.sha1
        );
        const serverBlob = new Blob([Uint8Array.from(serverJarBuffer)], { type: "application/java-archive" });
        const runtime = await resolveServerRuntimeJar(versionId, serverBlob);

        await mkdir(path.dirname(runtimeJarPath), { recursive: true });
        await writeFile(runtimeJarPath, Buffer.from(await runtime.blob.arrayBuffer()));
        console.error(`[mcsrc-mcp] Cached runtime jar for ${versionId}`);

        return runtime;
    }

    private async resolveVersionEntry(versionId: string): Promise<VersionListEntry> {
        const versions = await this.getVersions();
        const exact = versions.find(it => it.id === versionId);
        if (exact) {
            return exact;
        }

        const lower = versionId.toLowerCase();
        const suggestions = versions
            .filter(v =>
                v.id.toLowerCase().includes(lower)
                || lower.includes(v.id.toLowerCase())
                || (lower.includes("unobf") && v.type === "unobfuscated")
                || (`${lower}_unobfuscated` === v.id.toLowerCase())
            )
            .slice(0, 8)
            .map(v => v.id);

        const unobfuscatedHint = versions
            .filter(v => v.type === "unobfuscated")
            .slice(0, 5)
            .map(v => v.id);

        const parts = [
            `Unknown Minecraft version: ${versionId}`,
            VERSION_POLICY,
        ];
        if (suggestions.length > 0) {
            parts.push(`Did you mean: ${suggestions.join(", ")}`);
        } else if (unobfuscatedHint.length > 0) {
            parts.push(`Example unobfuscated ids: ${unobfuscatedHint.join(", ")}`);
        }
        parts.push("Call mc_versions with query/type filters to list allowed ids.");
        throw new Error(parts.join("\n"));
    }

    private async cachedDownload(url: string, filePath: string, expectedSha1?: string): Promise<Buffer> {
        const cached = await readOptionalFile(filePath);
        if (cached && (!expectedSha1 || sha1(cached) === expectedSha1)) {
            return cached;
        }

        const response = await this.fetchImpl(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (expectedSha1 && sha1(buffer) !== expectedSha1) {
            throw new Error(`SHA1 mismatch for ${url}`);
        }

        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, buffer);
        return buffer;
    }

    private async decompileClass(jar: MinecraftJar, className: string): Promise<DecompileResult> {
        const entry = jar.jar.entries[`${className}.class`];
        if (!entry) {
            return {
                className,
                checksum: 0,
                source: `// Class not found: ${className}`,
                tokens: [],
                language: "java",
            };
        }

        const cacheKey = `${jar.version}:${className}:${entry.crc32}:source`;
        const cached = this.decompileCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const decompileJar = new DecompileJar(jar.jar);
        const result = await this.scheduleDecompile(() => decompileWithTokens(decompileJar, className));
        this.decompileCache.set(cacheKey, result);
        return result;
    }

    private async getBytecode(jar: MinecraftJar, className: string): Promise<DecompileResult> {
        const entry = jar.jar.entries[`${className}.class`];
        if (!entry) {
            return {
                className,
                checksum: 0,
                source: `// Class not found: ${className}`,
                tokens: [],
                language: "bytecode",
            };
        }

        const cacheKey = `${jar.version}:${className}:${entry.crc32}:bytecode`;
        const cached = this.decompileCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const classData = [await entry.bytes().then(toArrayBuffer)];
        for (const innerClass of getClassNames(jar.jar)) {
            if (!innerClass.startsWith(`${className}$`)) {
                continue;
            }
            classData.push(await jar.jar.entries[`${innerClass}.class`].bytes().then(toArrayBuffer));
        }

        const indexer = await import("../java/build/generated/teavm/js/java.js");
        const result: DecompileResult = {
            className,
            checksum: entry.crc32,
            source: indexer.getBytecode(classData),
            tokens: [],
            language: "bytecode",
        };

        this.decompileCache.set(cacheKey, result);
        return result;
    }

    private async scheduleDecompile<T>(task: () => Promise<T>): Promise<T> {
        const previous = this.decompileQueue;
        let release!: () => void;
        this.decompileQueue = new Promise<void>(resolve => {
            release = resolve;
        });

        await previous;
        try {
            return await task();
        } finally {
            release();
        }
    }
}

/** Large enough for internal full reads used by method extract / diffs. */
const MAX_INTERNAL_READ_LINES = 100_000;

export function getClassNames(jar: Jar): string[] {
    return Object.keys(jar.entries)
        .filter(name => name.endsWith(".class"))
        .map(name => name.replace(/\.class$/, ""))
        .sort();
}

export function getEntriesWithCRC(jar: Jar): Map<string, EntryInfo> {
    const entries = new Map<string, EntryInfo>();

    for (const [pathName, file] of Object.entries(jar.entries)) {
        if (!pathName.endsWith(".class")) {
            continue;
        }

        const className = pathName.substring(0, pathName.length - 6);
        const lastSlash = pathName.lastIndexOf("/");
        const folder = lastSlash !== -1 ? pathName.substring(0, lastSlash + 1) : "";
        const fileName = pathName.substring(folder.length);
        const baseFileName = fileName.includes("$") ? fileName.split("$")[0] : fileName.replace(".class", "");
        const baseClassName = `${folder}${baseFileName}.class`;

        const existing = entries.get(baseClassName);
        if (existing) {
            existing.classCrcs.set(className, file.crc32);
            existing.totalUncompressedSize += file.uncompressedSize;
            continue;
        }

        entries.set(baseClassName, {
            classCrcs: new Map([[className, file.crc32]]),
            totalUncompressedSize: file.uncompressedSize,
        });
    }

    return entries;
}

async function resolveServerRuntimeJar(versionId: string, serverBlob: Blob): Promise<MinecraftJar> {
    const outerJar = await openJar(versionId, serverBlob);
    const versionsListEntry = outerJar.entries["META-INF/versions.list"];
    if (!versionsListEntry) {
        return { version: versionId, jar: outerJar, blob: serverBlob };
    }

    const versionsList = new TextDecoder().decode(await versionsListEntry.bytes());
    const firstLine = versionsList
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line.length > 0);

    if (!firstLine) {
        throw new Error(`Bundled server jar has an empty META-INF/versions.list for version: ${versionId}`);
    }

    const fields = firstLine.split("\t");
    const bundledJarPath = fields[2];
    if (fields.length < 3 || !bundledJarPath) {
        throw new Error(`Malformed META-INF/versions.list entry for version ${versionId}: ${firstLine}`);
    }

    const bundledEntryName = `META-INF/versions/${bundledJarPath}`;
    const bundledJarEntry = outerJar.entries[bundledEntryName];
    if (!bundledJarEntry) {
        throw new Error(`Bundled server runtime jar not found: ${bundledEntryName}`);
    }

    const bundledJarBlob = new Blob([Uint8Array.from(await bundledJarEntry.bytes())], { type: "application/java-archive" });
    return { version: versionId, jar: await openJar(versionId, bundledJarBlob), blob: bundledJarBlob };
}

async function decompileWithTokens(jar: DecompileJar, className: string): Promise<DecompileResult> {
    ensureNodeDecompilerGlobals();

    const allTokens = new Map<string, Token[]>();
    let currentContent: string | undefined;
    let currentTokens: Token[] | undefined;

    const sources = await vf.decompile(className, {
        source: async (name) => {
            const data = await jar.proxy[name]?.data;
            return data ?? null;
        },
        resources: jar.classes,
        tokenCollector: {
            start(content) {
                currentContent = content;
                currentTokens = [];
            },
            visitClass(start, length, declaration, name) {
                currentTokens?.push({ type: "class", start, length, className: name, declaration });
            },
            visitField(start, length, declaration, tokenClassName, name, descriptor) {
                currentTokens?.push({ type: "field", start, length, className: tokenClassName, declaration, name, descriptor });
            },
            visitMethod(start, length, declaration, tokenClassName, name, descriptor) {
                currentTokens?.push({ type: "method", start, length, className: tokenClassName, declaration, name, descriptor });
            },
            visitParameter(start, length, declaration, tokenClassName) {
                currentTokens?.push({ type: "parameter", start, length, className: tokenClassName, declaration });
            },
            visitLocal(start, length, declaration, tokenClassName) {
                currentTokens?.push({ type: "local", start, length, className: tokenClassName, declaration });
            },
            end() {
                if (currentContent && currentTokens) {
                    allTokens.set(currentContent, currentTokens);
                }
                currentContent = undefined;
                currentTokens = undefined;
            },
        },
        logger: {
            writeMessage(level, message, error) {
                if (level === "error") {
                    console.error(message, error);
                }
            },
        },
    });

    const source = sources[className] ?? `// Class not found: ${className}`;
    const checksum = jar.proxy[className]?.checksum ?? 0;
    const tokens = allTokens.get(source) ?? [];
    tokens.sort((a, b) => a.start - b.start);
    return { className, checksum, source, tokens, language: "java" };
}

function findDeclarationToken(tokens: Token[], memberName: string, descriptor?: string): MemberToken | undefined {
    return tokens.find((token): token is MemberToken => {
        if (!token.declaration || (token.type !== "method" && token.type !== "field")) {
            return false;
        }
        return token.name === memberName && (!descriptor || token.descriptor === descriptor);
    });
}

function findMethodDeclarationToken(tokens: Token[], memberName: string, descriptor?: string): MemberToken | undefined {
    return tokens.find((token): token is MemberToken => {
        if (!token.declaration || token.type !== "method") {
            return false;
        }
        return token.name === memberName && (!descriptor || token.descriptor === descriptor);
    });
}

function extractMemberSnippet(source: string, token: MemberToken): string {
    const lineStart = source.lastIndexOf("\n", token.start) + 1;
    const openBrace = source.indexOf("{", token.start);
    const semicolon = source.indexOf(";", token.start);

    if (openBrace === -1 || (semicolon !== -1 && semicolon < openBrace)) {
        const lineEnd = source.indexOf("\n", token.start);
        return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    }

    const blockEnd = findBlockEnd(source, openBrace);
    return source.slice(lineStart, blockEnd === -1 ? source.length : blockEnd + 1);
}

function findBlockEnd(source: string, openBrace: number): number {
    let depth = 0;
    for (let i = openBrace; i < source.length; i++) {
        const char = source[i];
        if (char === "{") {
            depth++;
        } else if (char === "}") {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

function findLocalReferences(result: DecompileResult, declaration: MemberToken): string[] {
    return result.tokens
        .filter((token): token is MemberToken => {
            if (token.declaration || token.type !== declaration.type) {
                return false;
            }
            return token.name === declaration.name && token.descriptor === declaration.descriptor;
        })
        .slice(0, 50)
        .map(token => {
            const location = getLocation(result.source, token.start);
            const line = getLine(result.source, token.start).trim();
            return `${result.className}:${location.line}:${location.column}: ${line}`;
        });
}

function getLocation(source: string, offset: number): { line: number; column: number; } {
    const sourceUpTo = source.slice(0, offset);
    const line = (sourceUpTo.match(/\n/g)?.length ?? 0) + 1;
    const column = sourceUpTo.length - sourceUpTo.lastIndexOf("\n");
    return { line, column };
}

function getLine(source: string, offset: number): string {
    const start = source.lastIndexOf("\n", offset) + 1;
    const end = source.indexOf("\n", offset);
    return source.slice(start, end === -1 ? source.length : end);
}

function limitLines(source: string, maxLines: number): string {
    const lines = source.split(/\r?\n/);
    if (lines.length <= maxLines) {
        return source;
    }
    return `${lines.slice(0, maxLines).join("\n")}\n// ... truncated after ${maxLines} lines`;
}

function extractBytecodeMethodSnippet(source: string, memberName: string, descriptor?: string): string | undefined {
    const lines = source.split(/\r?\n/);
    const headerIndex = lines.findIndex(line => matchesBytecodeMethodHeader(line, memberName, descriptor));
    if (headerIndex === -1) {
        return undefined;
    }

    let start = headerIndex;
    while (start > 0) {
        const previous = lines[start - 1];
        if (previous.startsWith("  //")) {
            start--;
            continue;
        }
        if (previous.trim().length === 0) {
            start--;
        }
        break;
    }

    let end = headerIndex + 1;
    while (end < lines.length) {
        const line = lines[end];
        if (line === "}") {
            break;
        }
        if (end > headerIndex && beginsNextBytecodeMethod(lines, end)) {
            break;
        }
        if (end > headerIndex && isBytecodeMethodHeader(line)) {
            break;
        }
        end++;
    }

    return lines.slice(start, end).join("\n").trimEnd();
}

function matchesBytecodeMethodHeader(line: string, memberName: string, descriptor?: string): boolean {
    const trimmed = line.trim();
    if (!trimmed.includes(memberName) || !isBytecodeMethodHeader(line)) {
        return false;
    }

    if (descriptor) {
        return trimmed.includes(`${memberName}${descriptor}`);
    }

    return trimmed.includes(`${memberName}(`) || trimmed.includes(`${memberName}<`);
}

function isBytecodeMethodHeader(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.length === 0) {
        return false;
    }

    return /\b(public|private|protected)\b/.test(trimmed) && trimmed.includes("(");
}

function beginsNextBytecodeMethod(lines: string[], index: number): boolean {
    if (!lines[index].startsWith("  // access flags")) {
        return false;
    }

    let cursor = index + 1;
    while (cursor < lines.length) {
        const line = lines[cursor];
        if (line.trim().length === 0) {
            cursor++;
            continue;
        }
        if (line.startsWith("  //")) {
            cursor++;
            continue;
        }
        return isBytecodeMethodHeader(line);
    }

    return false;
}

function normalizeClassName(className: string): string {
    return className
        .replace(/\\/g, "/")
        .replace(/\./g, "/")
        .replace(/\.class$/, "");
}

function safeFileName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function readOptionalFile(filePath: string): Promise<Buffer | undefined> {
    try {
        await access(filePath);
        return await readFile(filePath);
    } catch {
        return undefined;
    }
}

function sha1(buffer: Buffer): string {
    return createHash("sha1").update(buffer).digest("hex");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = Uint8Array.from(bytes);
    return copy.buffer;
}

function ensureNodeDecompilerGlobals(): void {
    if (typeof globalThis.navigator === "undefined") {
        Object.defineProperty(globalThis, "navigator", {
            value: { hardwareConcurrency: 4 },
            configurable: true,
        });
        return;
    }

    if (typeof globalThis.navigator.hardwareConcurrency !== "number") {
        Object.defineProperty(globalThis.navigator, "hardwareConcurrency", {
            value: 4,
            configurable: true,
        });
    }
}
