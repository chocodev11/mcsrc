export interface VersionListEntry {
    id: string;
    type: string;
    url: string;
    time: string;
    releaseTime: string;
    sha1: string;
}

export interface VersionsList {
    versions: VersionListEntry[];
}

export interface VersionManifest {
    id: string;
    downloads: {
        [key: string]: {
            url: string;
            sha1: string;
        };
    };
}

export interface McClassReadResult {
    version: string;
    className: string;
    mode: "source" | "bytecode";
    status: "found" | "missing";
    checksum: number;
    content: string;
    message?: string;
    truncation?: {
        truncated: boolean;
        total_lines: number;
        start_line: number;
        returned_lines: number;
        max_lines: number;
        note?: string;
    };
}

export interface McMethodReadResult {
    version: string;
    className: string;
    memberName: string;
    descriptor?: string;
    mode: "source" | "bytecode";
    status: "found" | "missing";
    checksum: number;
    content: string;
    message?: string;
}

export type ChangeState = "added" | "deleted" | "modified" | "unchanged";

export interface EntryInfo {
    classCrcs: Map<string, number>;
    totalUncompressedSize: number;
}

export interface ChangedClass {
    className: string;
    state: Exclude<ChangeState, "unchanged">;
}

export interface ChangedClassesResult {
    leftVersion: string;
    rightVersion: string;
    summary: {
        added: number;
        deleted: number;
        modified: number;
        /** Total changed classes before query filter. */
        total_changed: number;
        /** Classes matching query filter (before pagination). */
        matched: number;
    };
    classes: ChangedClass[];
    page: {
        total_count: number;
        count: number;
        offset: number;
        limit: number;
        has_more: boolean;
        next_offset: number | null;
    };
    message?: string;
}

export interface DiffClassResult {
    leftVersion: string;
    rightVersion: string;
    className: string;
    mode: "source" | "bytecode";
    status: ChangeState;
    diff: string;
    message?: string;
}

export interface DiffMethodResult {
    leftVersion: string;
    rightVersion: string;
    className: string;
    memberName: string;
    descriptor?: string;
    mode: "source" | "bytecode";
    status: ChangeState;
    leftStatus: "found" | "missing";
    rightStatus: "found" | "missing";
    diff: string;
    message?: string;
}

export interface BehaviorContextResult {
    version: string;
    className: string;
    checksum: number;
    memberName?: string;
    descriptor?: string;
    snippet: string;
    /** Same-class reference sites only — not jar-wide callers. */
    local_references: string[];
    message?: string;
}

export interface ClassMember {
    kind: "method" | "field";
    name: string;
    descriptor: string;
    line: number;
    declaration: boolean;
}

export interface ListMembersResult {
    version: string;
    className: string;
    status: "found" | "missing";
    checksum: number;
    members: ClassMember[];
    page: {
        total_count: number;
        count: number;
        offset: number;
        limit: number;
        has_more: boolean;
        next_offset: number | null;
    };
    message?: string;
}

export interface PrepareVersionResult {
    version: string;
    status: "ready";
    class_count: number;
    message: string;
}

export interface VersionsResult {
    count: number;
    versions: Array<{ id: string; type: string; releaseTime: string }>;
    page: {
        total_count: number;
        count: number;
        offset: number;
        limit: number;
        has_more: boolean;
        next_offset: number | null;
    };
    policy: string;
    message?: string;
}

export interface SearchClassResult {
    version: string;
    query: string;
    classes: string[];
    page: {
        total_count: number;
        count: number;
        offset: number;
        limit: number;
        has_more: boolean;
        next_offset: number | null;
    };
    message?: string;
}
