import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vf from "@run-slicer/vf";
import { openJar, type Jar } from "../src/utils/Jar.ts";
import type { MemberToken, Token } from "../src/logic/Tokens.ts";
import { DecompileJar, type DecompileResult } from "../src/workers/decompile/types.ts";
import { searchClasses } from "./classSearch.ts";
import { createUnifiedDiff, getChangedEntries } from "./diff.ts";
import {
    DEFAULT_DIFF_MAX_LINES,
    DEFAULT_METHOD_MAX_LINES,
    emptyFieldMessage,
    paginate,
    SEARCH_MATCH_CAP,
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
    MethodCandidate,
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

/**
 * Disk cache for jars / downloads. Never defaults under the process cwd (often the
 * open agent workspace) — that pollutes repos and can hit git ignore edge cases.
 * Override with MCSRC_CACHE_DIR or options.cacheDir (absolute path recommended).
 */
export function resolveCacheDir(override?: string): string {
    const fromEnvOrOpt = override ?? process.env.MCSRC_CACHE_DIR;
    if (fromEnvOrOpt && fromEnvOrOpt.trim()) {
        return path.resolve(fromEnvOrOpt.trim());
    }
    // Windows: %LOCALAPPDATA%\mcsrc
    // Unix: $XDG_CACHE_HOME/mcsrc or ~/.cache/mcsrc
    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
        return path.join(localAppData, "mcsrc");
    }
    const xdg = process.env.XDG_CACHE_HOME;
    if (xdg && xdg.trim()) {
        return path.join(xdg.trim(), "mcsrc");
    }
    return path.join(os.homedir(), ".cache", "mcsrc");
}

export class MinecraftReferenceService {
    private readonly cacheDir: string;
    private readonly fetchImpl: FetchImpl;
    private versionsPromise: Promise<VersionListEntry[]> | undefined;
    private jarPromises = new Map<string, Promise<MinecraftJar>>();
    private decompileCache = new Map<string, DecompileResult>();
    private decompileQueue: Promise<void> = Promise.resolve();

    constructor(options: ReferenceServiceOptions = {}) {
        this.cacheDir = resolveCacheDir(options.cacheDir);
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
            versions: items,
            page,
            message: items.length === 0
                ? emptyFieldMessage("versions", "no versions matched", [
                    "Drop query/type filters",
                    "type=unobfuscated for experimental builds",
                    "Only major>=26 + curated unobfuscated ids",
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
        };
    }

    async searchClass(
        version: string,
        query: string,
        limit = 30,
        offset = 0
    ): Promise<SearchClassResult> {
        const jar = await this.getJar(version);
        // Fetch cap+1 so we can report total_capped honestly (not pretend the jar has fewer hits).
        const ranked = searchClasses(query, getClassNames(jar.jar), SEARCH_MATCH_CAP + 1);
        const totalCapped = ranked.length > SEARCH_MATCH_CAP;
        const candidates = totalCapped ? ranked.slice(0, SEARCH_MATCH_CAP) : ranked;
        const { items, page } = paginate(candidates, limit, offset);

        return {
            query,
            classes: items,
            page,
            ...(totalCapped
                ? { total_capped: true, candidate_cap: SEARCH_MATCH_CAP }
                : {}),
            message: items.length === 0
                ? emptyFieldMessage("classes", `no match for "${query}"`, [
                    "Try simple name (ServerLevel) or package path (net/minecraft/server)",
                    "Results are slash-form names",
                ])
                : totalCapped
                    ? `Match list capped at ${SEARCH_MATCH_CAP}; narrow query for completeness`
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
                className: normalizedClassName,
                mode,
                status: "missing",
                content: `// Class not found: ${normalizedClassName}`,
                message: emptyFieldMessage("content", `class ${normalizedClassName} not found in ${version}`, [
                    "mc_search_class for slash-form name",
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
            className: normalizedClassName,
            mode,
            status: "found",
            content: sliced.content,
            truncation: sliced.truncation.truncated ? sliced.truncation : undefined,
            message: sliced.truncation.truncated ? sliced.truncation.note : undefined,
        };
    }

    async readMethod(
        version: string,
        className: string,
        memberName: string,
        descriptor: string | undefined,
        mode: Mode,
        options: { maxLines?: number } = {}
    ): Promise<McMethodReadResult> {
        const jar = await this.getJar(version);
        const normalizedClassName = normalizeClassName(className);
        const methodName = memberName.trim();
        const entry = jar.jar.entries[`${normalizedClassName}.class`];

        if (!entry) {
            return {
                className: normalizedClassName,
                memberName: methodName,
                descriptor,
                mode,
                status: "missing",
                content: `// Class not found: ${normalizedClassName}`,
                message: emptyFieldMessage("content", `class ${normalizedClassName} not found`, [
                    "mc_search_class for slash-form name",
                ]),
            };
        }

        if (mode === "source") {
            return this.readSourceMethodResult(version, normalizedClassName, methodName, descriptor, options);
        }
        return this.readBytecodeMethodResult(version, normalizedClassName, methodName, descriptor, options);
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
                className: normalizedClassName,
                status: "missing",
                members: [],
                page: emptyPage,
                message: emptyFieldMessage("members", `class ${normalizedClassName} not found`, [
                    "mc_search_class first",
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
            className: normalizedClassName,
            status: "found",
            members: items,
            page,
            message: items.length === 0
                ? emptyFieldMessage("members", "no members matched", [
                    "kind=all, drop query; inner classes use Outer$Inner",
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
                ? emptyFieldMessage("classes", "no changed classes in page/filter", [
                    query ? "Relax query" : "Versions may be CRC-identical",
                    "Only advance offset when has_more",
                ])
                : page.has_more
                    ? `${items.length}/${page.total_count}; offset=${page.next_offset} for more`
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
        const status = await this.getClassChangeStatus(leftVersion, rightVersion, normalizedClassName);

        // Full cached decompile text for accurate diffs (not the truncated tool view).
        const [leftFull, rightFull] = await Promise.all([
            this.readFullClassContentIfPresent(leftVersion, normalizedClassName, mode),
            this.readFullClassContentIfPresent(rightVersion, normalizedClassName, mode),
        ]);

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
            message = emptyFieldMessage("diff", "CRCs match (no class-level change)", [
                "Pick from mc_changed_classes",
            ]);
        } else if (rawDiff.length === 0 && status === "modified" && mode === "source") {
            message = emptyFieldMessage(
                "diff",
                "source identical despite CRC change (metadata-only)",
                ["Retry mode=bytecode"]
            );
        } else if (rawDiff.length === 0) {
            message = emptyFieldMessage("diff", `status=${status} but ${mode} text identical`, [
                mode === "source" ? "Try mode=bytecode" : "Non-textual change",
            ]);
        }

        if (rawDiff.length > 0) {
            const sliced = sliceLines(rawDiff, { maxLines: options.maxLines ?? DEFAULT_DIFF_MAX_LINES });
            return {
                className: normalizedClassName,
                mode,
                status,
                diff: sliced.content,
                truncation: sliced.truncation.truncated ? sliced.truncation : undefined,
                message: sliced.truncation.truncated
                    ? [message, sliced.truncation.note].filter(Boolean).join("; ")
                    : message,
            };
        }

        return {
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
        mode: Mode,
        options: { maxLines?: number } = {}
    ): Promise<DiffMethodResult> {
        const normalizedClassName = normalizeClassName(className);
        const methodName = memberName.trim();
        const [left, right, status] = await Promise.all([
            this.readMethod(leftVersion, normalizedClassName, methodName, descriptor, mode, options),
            this.readMethod(rightVersion, normalizedClassName, methodName, descriptor, mode, options),
            this.getClassChangeStatus(leftVersion, rightVersion, normalizedClassName),
        ]);

        if (left.status === "ambiguous" || right.status === "ambiguous") {
            const candidates = [
                ...(left.candidates ?? []),
                ...(right.candidates ?? []),
            ];
            const unique = uniqueCandidates(candidates);
            return {
                className: normalizedClassName,
                memberName: methodName,
                descriptor,
                mode,
                status,
                leftStatus: left.status,
                rightStatus: right.status,
                diff: "",
                message: emptyFieldMessage("diff", "method name is overloaded", [
                    `Pass descriptor; candidates: ${unique.map(c => c.descriptor).join(", ")}`,
                ]),
            };
        }

        const leftText = left.status === "found" ? left.content : "";
        const rightText = right.status === "found" ? right.content : "";
        let diff = "";
        let message: string | undefined;

        if (left.status === "missing" && right.status === "missing") {
            message = emptyFieldMessage("diff", "method missing on both sides", [
                "mc_list_members on each version",
            ]);
        } else if (leftText === rightText) {
            message = emptyFieldMessage(
                "diff",
                left.status !== right.status
                    ? `presence differs (left=${left.status}, right=${right.status})`
                    : "method text identical",
                [
                    status === "modified" && mode === "source"
                        ? "CRC changed; try mode=bytecode or mc_diff_class"
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

        if (diff.length > 0) {
            const sliced = sliceLines(diff, { maxLines: options.maxLines ?? DEFAULT_DIFF_MAX_LINES });
            return {
                className: normalizedClassName,
                memberName: methodName,
                descriptor: descriptor ?? left.descriptor ?? right.descriptor,
                mode,
                status,
                leftStatus: left.status,
                rightStatus: right.status,
                diff: sliced.content,
                truncation: sliced.truncation.truncated ? sliced.truncation : undefined,
                message: sliced.truncation.truncated
                    ? [message, sliced.truncation.note].filter(Boolean).join("; ")
                    : message,
            };
        }

        return {
            className: normalizedClassName,
            memberName: methodName,
            descriptor: descriptor ?? left.descriptor ?? right.descriptor,
            mode,
            status,
            leftStatus: left.status,
            rightStatus: right.status,
            diff: "",
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
                className: normalizedClassName,
                memberName,
                descriptor,
                snippet: `// Class not found: ${normalizedClassName}`,
                message: emptyFieldMessage("snippet", "class not found", ["mc_search_class"]),
            };
        }

        const result = await this.decompileClass(jar, normalizedClassName);
        const matches = memberName
            ? findDeclarationTokens(result.tokens, memberName, descriptor)
            : [];
        if (memberName && matches.length > 1 && !descriptor) {
            return {
                className: normalizedClassName,
                memberName,
                descriptor,
                snippet: "",
                message: emptyFieldMessage("snippet", "ambiguous member", [
                    `Pass descriptor; candidates: ${matches.map(m => m.descriptor).join(", ")}`,
                ]),
            };
        }
        const token = matches[0];
        const rawSnippet = token
            ? extractMemberSnippet(result.source, token)
            : limitLines(result.source, 100);
        const sliced = sliceLines(rawSnippet, { maxLines: DEFAULT_METHOD_MAX_LINES });
        const local_references = includeLocalRefs && token
            ? findLocalReferences(result, token)
            : undefined;

        let message: string | undefined;
        if (memberName && !token) {
            message = emptyFieldMessage(
                "snippet",
                `no declaration for ${memberName}${descriptor ?? ""}; class head returned`,
                ["mc_list_members for names/descriptors"]
            );
        } else if (includeLocalRefs) {
            message = !local_references || local_references.length === 0
                ? emptyFieldMessage("local_references", "none in this class", [
                    "Same-class only — not jar-wide callers",
                ])
                : "local_references are same-class only";
        }

        return {
            className: normalizedClassName,
            memberName,
            descriptor: descriptor ?? token?.descriptor,
            snippet: sliced.content,
            ...(local_references && local_references.length > 0 ? { local_references } : {}),
            message: [message, sliced.truncation.truncated ? sliced.truncation.note : undefined]
                .filter(Boolean)
                .join("; ") || undefined,
        };
    }

    private async readFullClassContentIfPresent(version: string, className: string, mode: Mode): Promise<string> {
        const jar = await this.getJar(version);
        if (!jar.jar.entries[`${className}.class`]) {
            return "";
        }
        const result = mode === "source"
            ? await this.decompileClass(jar, className)
            : await this.getBytecode(jar, className);
        return result.source;
    }

    private async readSourceMethodResult(
        version: string,
        className: string,
        memberName: string,
        descriptor: string | undefined,
        options: { maxLines?: number }
    ): Promise<McMethodReadResult> {
        const jar = await this.getJar(version);
        const result = await this.decompileClass(jar, className);
        const matches = findMethodDeclarationTokens(result.tokens, memberName, descriptor);

        if (matches.length === 0) {
            return {
                className,
                memberName,
                descriptor,
                mode: "source",
                status: "missing",
                content: `// Method not found: ${memberName}${descriptor ?? ""}`,
                message: emptyFieldMessage("content", `method ${memberName}${descriptor ?? ""} not found`, [
                    "mc_list_members; pass descriptor if overloaded; <init> for constructors",
                ]),
            };
        }

        if (matches.length > 1 && !descriptor) {
            const candidates = matches.map(token => ({
                name: token.name,
                descriptor: token.descriptor,
                line: getLocation(result.source, token.start).line,
            }));
            return {
                className,
                memberName,
                mode: "source",
                status: "ambiguous",
                content: "",
                candidates,
                message: emptyFieldMessage("content", `ambiguous overload of ${memberName}`, [
                    `Pass descriptor; candidates: ${candidates.map(c => c.descriptor).join(", ")}`,
                ]),
            };
        }

        const token = matches[0];
        const raw = extractMemberSnippet(result.source, token);
        const sliced = sliceLines(raw, { maxLines: options.maxLines ?? DEFAULT_METHOD_MAX_LINES });
        return {
            className,
            memberName,
            descriptor: token.descriptor,
            mode: "source",
            status: "found",
            content: sliced.content,
            truncation: sliced.truncation.truncated ? sliced.truncation : undefined,
            message: sliced.truncation.truncated ? sliced.truncation.note : undefined,
        };
    }

    private async readBytecodeMethodResult(
        version: string,
        className: string,
        memberName: string,
        descriptor: string | undefined,
        options: { maxLines?: number }
    ): Promise<McMethodReadResult> {
        const jar = await this.getJar(version);
        const result = await this.getBytecode(jar, className);
        const candidates = listBytecodeMethodCandidates(result.source, memberName);

        if (descriptor) {
            const content = extractBytecodeMethodSnippet(result.source, memberName, descriptor);
            if (!content) {
                return {
                    className,
                    memberName,
                    descriptor,
                    mode: "bytecode",
                    status: "missing",
                    content: `// Method not found: ${memberName}${descriptor}`,
                    message: emptyFieldMessage("content", `method ${memberName}${descriptor} not found`, [
                        "mc_list_members; check descriptor",
                    ]),
                };
            }
            const sliced = sliceLines(content, { maxLines: options.maxLines ?? DEFAULT_METHOD_MAX_LINES });
            return {
                className,
                memberName,
                descriptor,
                mode: "bytecode",
                status: "found",
                content: sliced.content,
                truncation: sliced.truncation.truncated ? sliced.truncation : undefined,
                message: sliced.truncation.truncated ? sliced.truncation.note : undefined,
            };
        }

        if (candidates.length === 0) {
            return {
                className,
                memberName,
                mode: "bytecode",
                status: "missing",
                content: `// Method not found: ${memberName}`,
                message: emptyFieldMessage("content", `method ${memberName} not found`, [
                    "mc_list_members; pass descriptor if overloaded",
                ]),
            };
        }

        if (candidates.length > 1) {
            return {
                className,
                memberName,
                mode: "bytecode",
                status: "ambiguous",
                content: "",
                candidates,
                message: emptyFieldMessage("content", `ambiguous overload of ${memberName}`, [
                    `Pass descriptor; candidates: ${candidates.map(c => c.descriptor).join(", ")}`,
                ]),
            };
        }

        const chosen = candidates[0];
        const content = extractBytecodeMethodSnippet(result.source, memberName, chosen.descriptor)
            ?? extractBytecodeMethodSnippet(result.source, memberName);
        if (!content) {
            return {
                className,
                memberName,
                descriptor: chosen.descriptor,
                mode: "bytecode",
                status: "missing",
                content: `// Method not found: ${memberName}`,
                message: emptyFieldMessage("content", `method ${memberName} not found`, [
                    "mc_list_members",
                ]),
            };
        }
        const sliced = sliceLines(content, { maxLines: options.maxLines ?? DEFAULT_METHOD_MAX_LINES });
        return {
            className,
            memberName,
            descriptor: chosen.descriptor,
            mode: "bytecode",
            status: "found",
            content: sliced.content,
            truncation: sliced.truncation.truncated ? sliced.truncation : undefined,
            message: sliced.truncation.truncated ? sliced.truncation.note : undefined,
        };
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

function findDeclarationTokens(tokens: Token[], memberName: string, descriptor?: string): MemberToken[] {
    return tokens.filter((token): token is MemberToken => {
        if (!token.declaration || (token.type !== "method" && token.type !== "field")) {
            return false;
        }
        return token.name === memberName && (!descriptor || token.descriptor === descriptor);
    });
}

function findMethodDeclarationTokens(tokens: Token[], memberName: string, descriptor?: string): MemberToken[] {
    return tokens.filter((token): token is MemberToken => {
        if (!token.declaration || token.type !== "method") {
            return false;
        }
        return token.name === memberName && (!descriptor || token.descriptor === descriptor);
    });
}

function uniqueCandidates(candidates: MethodCandidate[]): MethodCandidate[] {
    return candidates.filter((candidate, index, all) =>
        all.findIndex(other =>
            other.name === candidate.name && other.descriptor === candidate.descriptor
        ) === index
    );
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

/** Collect overload candidates from bytecode disassembly headers. */
function listBytecodeMethodCandidates(source: string, memberName: string): MethodCandidate[] {
    const lines = source.split(/\r?\n/);
    const candidates: MethodCandidate[] = [];
    for (const line of lines) {
        if (!matchesBytecodeMethodHeader(line, memberName)) {
            continue;
        }
        const descriptor = extractBytecodeDescriptor(line, memberName);
        if (!descriptor) {
            continue;
        }
        if (!candidates.some(c => c.descriptor === descriptor)) {
            candidates.push({ name: memberName, descriptor });
        }
    }
    return candidates;
}

function extractBytecodeDescriptor(line: string, memberName: string): string | undefined {
    const trimmed = line.trim();
    // Common forms: "name(DESC" or "nameDESC" where DESC starts with (
    const withParen = trimmed.indexOf(`${memberName}(`);
    if (withParen !== -1) {
        const fromName = trimmed.slice(withParen + memberName.length);
        const close = findDescriptorEnd(fromName);
        if (close !== -1) {
            return fromName.slice(0, close + 1);
        }
    }
    const idx = trimmed.indexOf(memberName);
    if (idx === -1) {
        return undefined;
    }
    const after = trimmed.slice(idx + memberName.length);
    if (after.startsWith("(")) {
        const close = findDescriptorEnd(after);
        return close === -1 ? undefined : after.slice(0, close + 1);
    }
    return undefined;
}

function findDescriptorEnd(descriptorStart: string): number {
    // JVM method descriptor ends at the return type after ')'
    const closeParen = descriptorStart.indexOf(")");
    if (closeParen === -1) {
        return -1;
    }
    // include return type token(s) if present on the same header line
    let i = closeParen + 1;
    if (i >= descriptorStart.length) {
        return closeParen;
    }
    // return types: V, I, J, ... or L...; or [
    if (descriptorStart[i] === "L") {
        const semi = descriptorStart.indexOf(";", i);
        return semi === -1 ? closeParen : semi;
    }
    if (descriptorStart[i] === "[") {
        while (i < descriptorStart.length && descriptorStart[i] === "[") {
            i++;
        }
        if (descriptorStart[i] === "L") {
            const semi = descriptorStart.indexOf(";", i);
            return semi === -1 ? closeParen : semi;
        }
        return i < descriptorStart.length ? i : closeParen;
    }
    // single-char primitive return
    if (/[VZBCSIJFD]/.test(descriptorStart[i] ?? "")) {
        return i;
    }
    // Human-readable headers without JVM desc — use "(...)" only
    return closeParen;
}

function matchesBytecodeMethodHeader(line: string, memberName: string, descriptor?: string): boolean {
    const trimmed = line.trim();
    if (!trimmed.includes(memberName) || !isBytecodeMethodHeader(line)) {
        return false;
    }

    if (descriptor) {
        return trimmed.includes(`${memberName}${descriptor}`)
            || trimmed.includes(`${memberName}(${descriptor.startsWith("(") ? descriptor.slice(1) : descriptor}`);
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
