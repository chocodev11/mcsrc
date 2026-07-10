import { Alert, Empty, Spin } from "antd";
import { useEffect, useState } from "react";
import { useObservable } from "../utils/UseObservable";
import { formatReference, goToReference, findReferenceToken, referenceSearchState } from "../logic/FindAllReferences";
import type { ReferenceKey, ReferenceString } from "../workers/JarIndex";
import { map, Observable } from "rxjs";
import { openTab } from "../logic/Tabs";
import { referencesQuery } from "../logic/State";
import { minecraftJar, type MinecraftJar } from "../logic/MinecraftApi";
import { decompileClass } from "../workers/decompile/client";
import { getTokenLocation } from "../logic/Tokens";
import { formatJavaClassName } from "../utils/JavaDescriptors";

function getUsageClass(usage: ReferenceString): string {
    if (usage.startsWith("m:") || usage.startsWith("f:")) {
        const parts = usage.slice(2).split(":");
        return parts[0];
    }

    // class usage
    return usage;
}

interface ReferenceGroup {
    className: string;
    references: ReferenceString[];
}

const groupedResults: Observable<ReferenceGroup[]> = referenceSearchState.pipe(
    map(state => {
        const results = state.results;
        const groups: Record<string, ReferenceString[]> = {};

        for (const usage of results) {
            const className = getUsageClass(usage);
            if (!groups[className]) {
                groups[className] = [];
            }
            groups[className].push(usage);
        }

        return Object.entries(groups).map(([className, references]) => ({
            className,
            references
        }));
    })
);

interface UsageGroupItemProps {
    group: ReferenceGroup;
    previews: Map<ReferenceString, ReferencePreview>;
}

interface ReferencePreview {
    line: number;
    snippet: string;
}

function getReferenceKindLabel(reference: ReferenceString): string {
    if (reference.startsWith("m:")) {
        return "method";
    }
    if (reference.startsWith("f:")) {
        return "field";
    }
    return "class";
}

function formatPathForDisplay(className: string): string {
    return `${className}.java`;
}

const UsageGroupItem = ({ group, previews }: UsageGroupItemProps) => {
    const query = useObservable(referencesQuery)!;

    return (
        <div className="reference-group">
            <div
                onClick={() => openTab(group.className + ".class")}
                className="reference-group-title"
            >
                <div className="reference-group-title-main">
                    <span className="reference-group-name">{formatPathForDisplay(group.className)}</span>
                    <span className="reference-group-count">{group.references.length} match{group.references.length === 1 ? "" : "es"}</span>
                </div>
                <div className="reference-group-subtitle">{formatJavaClassName(group.className)}</div>
            </div>
            <div className="reference-items">
                {group.references.map((reference, index) => (
                    <div
                        key={index}
                        onClick={() => goToReference(query, reference)}
                        className="reference-item"
                    >
                        <div className="reference-item-gutter">
                            {previews.get(reference)?.line ?? "?"}
                        </div>
                        <div className="reference-item-body">
                            <div className="reference-item-line">
                                <span className="reference-item-kind">{getReferenceKindLabel(reference)}</span>
                                <span className="reference-item-location">
                                    {previews.get(reference)?.line ? `Line ${previews.get(reference)!.line}` : formatReference(reference)}
                                </span>
                            </div>
                            {previews.get(reference)?.snippet && (
                                <div className="reference-item-snippet">
                                    {previews.get(reference)!.snippet}
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

function getLineSnippet(source: string, line: number): string {
    const lines = source.split("\n");
    return (lines[line - 1] || "").trim();
}

async function resolveReferencePreviews(query: ReferenceKey, groups: ReferenceGroup[], jar: MinecraftJar): Promise<Map<ReferenceString, ReferencePreview>> {
    const previews = new Map<ReferenceString, ReferencePreview>();

    await Promise.all(groups.map(async (group) => {
        const result = await decompileClass(group.className, jar.jar);

        for (const reference of group.references) {
            const token = findReferenceToken(query, reference, result);
            if (!token) {
                continue;
            }

            const location = getTokenLocation(result, token);
            previews.set(reference, {
                line: location.line,
                snippet: getLineSnippet(result.source, location.line)
            });
        }
    }));

    return previews;
}

const UsageResults = () => {
    const referenceState = useObservable(referenceSearchState);
    const results = useObservable(groupedResults) || [];
    const currentJar = useObservable(minecraftJar);
    const query = useObservable(referencesQuery);
    const [previews, setPreviews] = useState<Map<ReferenceString, ReferencePreview>>(new Map());

    useEffect(() => {
        let cancelled = false;

        if (!currentJar || !query || referenceState?.status !== "success" || results.length === 0) {
            setPreviews(new Map());
            return;
        }

        void resolveReferencePreviews(query as ReferenceKey, results, currentJar).then((resolvedPreviews) => {
            if (!cancelled) {
                setPreviews(resolvedPreviews);
            }
        }).catch((error: unknown) => {
            console.error("Failed to resolve reference previews", error);
            if (!cancelled) {
                setPreviews(new Map());
            }
        });

        return () => {
            cancelled = true;
        };
    }, [currentJar, query, referenceState?.status, results]);

    if (referenceState?.status === "loading") {
        return (
            <div className="reference-state">
                <Spin tip="Searching references..." />
            </div>
        );
    }

    if (referenceState?.status === "error") {
        return (
            <div className="reference-state">
                <Alert
                    type="error"
                    showIcon
                    message="Failed to find references"
                    description={referenceState.error || "Unknown error"}
                />
            </div>
        );
    }

    if (referenceState?.status === "success" && results.length === 0) {
        return (
            <div className="reference-state">
                <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="No references found for this symbol"
                />
            </div>
        );
    }

    return (
        <div className="reference-results">
            {results.map((group, index) => (
                <UsageGroupItem key={index} group={group} previews={previews} />
            ))}
        </div>
    );
};

export default UsageResults;
