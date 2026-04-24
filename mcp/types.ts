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
    };
    classes: ChangedClass[];
}

export interface DiffClassResult {
    leftVersion: string;
    rightVersion: string;
    className: string;
    mode: "source" | "bytecode";
    status: ChangeState;
    diff: string;
}

export interface BehaviorContextResult {
    version: string;
    className: string;
    checksum: number;
    memberName?: string;
    descriptor?: string;
    snippet: string;
    references: string[];
}
