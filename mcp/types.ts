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
    /** Present for navigation; omitted from empty noise when missing. */
    className: string;
    mode: "source" | "bytecode";
    status: "found" | "missing";
    content: string;
    truncation?: {
        truncated: boolean;
        total_lines: number;
        start_line: number;
        returned_lines: number;
        max_lines: number;
        note?: string;
    };
    message?: string;
}

export interface MethodCandidate {
    name: string;
    descriptor: string;
    line?: number;
}

export interface McMethodReadResult {
    className: string;
    memberName: string;
    descriptor?: string;
    mode: "source" | "bytecode";
    status: "found" | "missing" | "ambiguous";
    content: string;
    candidates?: MethodCandidate[];
    truncation?: {
        truncated: boolean;
        total_lines: number;
        start_line: number;
        returned_lines: number;
        max_lines: number;
        note?: string;
    };
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
    className: string;
    mode: "source" | "bytecode";
    status: ChangeState;
    diff: string;
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

export interface DiffMethodResult {
    className: string;
    memberName: string;
    descriptor?: string;
    mode: "source" | "bytecode";
    status: ChangeState;
    leftStatus: "found" | "missing" | "ambiguous";
    rightStatus: "found" | "missing" | "ambiguous";
    diff: string;
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

export interface BehaviorContextResult {
    className: string;
    memberName?: string;
    descriptor?: string;
    snippet: string;
    /** Same-class reference sites only — not jar-wide callers. */
    local_references?: string[];
    message?: string;
}

export interface ClassMember {
    kind: "method" | "field";
    name: string;
    descriptor: string;
    line: number;
}

export interface ListMembersResult {
    className: string;
    status: "found" | "missing";
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
}

export interface VersionsResult {
    versions: Array<{ id: string; type: string; releaseTime: string }>;
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

export interface SearchClassResult {
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
    /** True when more than candidate_cap matches exist; total_count is capped. */
    total_capped?: boolean;
    candidate_cap?: number;
    message?: string;
}
