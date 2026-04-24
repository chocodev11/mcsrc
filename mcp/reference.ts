import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vf from "@run-slicer/vf";
import { openJar, type Jar } from "../src/utils/Jar.ts";
import { performSearch } from "../src/logic/Search.ts";
import type { MemberToken, Token } from "../src/logic/Tokens.ts";
import { DecompileJar, type DecompileResult } from "../src/workers/decompile/types.ts";
import { createUnifiedDiff, getChangedEntries } from "./diff.ts";
import { EXPERIMENTAL_VERSIONS, VERSIONS_URL } from "./versions.ts";
import type {
    BehaviorContextResult,
    ChangedClass,
    ChangedClassesResult,
    DiffClassResult,
    EntryInfo,
    McClassReadResult,
    McMethodReadResult,
    VersionListEntry,
    VersionManifest,
    VersionsList,
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

    async getVersions(): Promise<VersionListEntry[]> {
        this.versionsPromise ??= this.fetchVersions();
        return this.versionsPromise;
    }

    async searchClass(version: string, query: string, limit = 100): Promise<string[]> {
        const jar = await this.getJar(version);
        const classes = getClassNames(jar.jar);
        return performSearch(query, classes).slice(0, limit);
    }

    async readClass(version: string, className: string, mode: Mode): Promise<McClassReadResult> {
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
            };
        }

        const result = mode === "source"
            ? await this.decompileClass(jar, normalizedClassName)
            : await this.getBytecode(jar, normalizedClassName);

        return {
            version,
            className: normalizedClassName,
            mode,
            status: "found",
            checksum: result.checksum,
            content: result.source,
        };
    }

    async readMethod(
        version: string,
        className: string,
        memberName: string,
        descriptor: string | undefined,
        mode: Mode
    ): Promise<McMethodReadResult> {
        const normalizedClassName = normalizeClassName(className);
        const methodName = memberName.trim();
        const result = await this.readClass(version, normalizedClassName, mode);

        if (result.status === "missing") {
            return {
                version,
                className: normalizedClassName,
                memberName: methodName,
                descriptor,
                mode,
                status: "missing",
                checksum: 0,
                content: result.content,
            };
        }

        const content = mode === "source"
            ? await this.readSourceMethod(version, normalizedClassName, methodName, descriptor)
            : await this.readBytecodeMethod(version, normalizedClassName, methodName, descriptor);

        return {
            version,
            className: normalizedClassName,
            memberName: methodName,
            descriptor,
            mode,
            status: content ? "found" : "missing",
            checksum: result.checksum,
            content: content ?? `// Method not found: ${methodName}${descriptor ?? ""}`,
        };
    }

    async getChangedClasses(
        leftVersion: string,
        rightVersion: string,
        query?: string,
        hideSameSize = false
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
        const summary = { added: 0, deleted: 0, modified: 0 };

        for (const [classFile, state] of [...changes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            summary[state]++;
            const className = classFile.replace(/\.class$/, "");
            if (lowerQuery && !className.toLowerCase().includes(lowerQuery)) {
                continue;
            }
            classes.push({ className, state });
        }

        return {
            leftVersion,
            rightVersion,
            summary,
            classes,
        };
    }

    async diffClass(
        leftVersion: string,
        rightVersion: string,
        className: string,
        mode: Mode
    ): Promise<DiffClassResult> {
        const normalizedClassName = normalizeClassName(className);
        const [left, right, changed] = await Promise.all([
            this.readClass(leftVersion, normalizedClassName, mode),
            this.readClass(rightVersion, normalizedClassName, mode),
            this.getChangedClasses(leftVersion, rightVersion),
        ]);
        const status = changed.classes.find(it => it.className === normalizedClassName)?.state ?? "unchanged";
        const rawDiff = status === "unchanged"
            ? ""
            : createUnifiedDiff(
                `${leftVersion}/${normalizedClassName}.${mode}`,
                `${rightVersion}/${normalizedClassName}.${mode}`,
                left.status === "found" ? left.content : "",
                right.status === "found" ? right.content : ""
            );
        const diff = rawDiff.length > 0
            ? rawDiff
            : status === "modified" && mode === "source"
                ? "// Decompiled source is identical for both versions. Try mode=bytecode to inspect bytecode-only or metadata-only changes."
                : rawDiff;

        return {
            leftVersion,
            rightVersion,
            className: normalizedClassName,
            mode,
            status,
            diff,
        };
    }

    async getBehaviorContext(
        version: string,
        className: string,
        memberName?: string,
        descriptor?: string,
        includeCallers = false
    ): Promise<BehaviorContextResult> {
        const jar = await this.getJar(version);
        const normalizedClassName = normalizeClassName(className);
        const result = await this.decompileClass(jar, normalizedClassName);
        const token = memberName ? findDeclarationToken(result.tokens, memberName, descriptor) : undefined;
        const snippet = token ? extractMemberSnippet(result.source, token) : limitLines(result.source, 240);
        const references = includeCallers && token
            ? findLocalReferences(result, token)
            : [];

        return {
            version,
            className: normalizedClassName,
            checksum: result.checksum,
            memberName,
            descriptor,
            snippet,
            references,
        };
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
            promise = this.loadJar(versionId);
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

        const version = (await this.getVersions()).find(it => it.id === versionId);
        if (!version) {
            throw new Error(`Unknown Minecraft version: ${versionId}`);
        }

        const manifest = await this.getJson<VersionManifest>(version.url);
        const serverDownload = manifest.downloads.server;
        if (!serverDownload?.url) {
            throw new Error(`No server jar download URL found for version: ${versionId}`);
        }

        const serverJarBuffer = await this.cachedDownload(
            serverDownload.url,
            path.join(this.cacheDir, "downloads", `${safeFileName(versionId)}-server.jar`),
            serverDownload.sha1
        );
        const serverBlob = new Blob([Uint8Array.from(serverJarBuffer)], { type: "application/java-archive" });
        const runtime = await resolveServerRuntimeJar(versionId, serverBlob);

        await mkdir(path.dirname(runtimeJarPath), { recursive: true });
        await writeFile(runtimeJarPath, Buffer.from(await runtime.blob.arrayBuffer()));

        return runtime;
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
    return className.replace(/\\/g, "/").replace(/\.class$/, "");
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
