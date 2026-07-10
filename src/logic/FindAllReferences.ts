import { BehaviorSubject, catchError, combineLatest, from, map, Observable, of, startWith, switchMap } from "rxjs";
import { jarIndex, type ReferenceKey, type ReferenceString } from "../workers/JarIndex";
import { openTab } from "./Tabs";
import { referencesQuery, referencesRequestNonce } from "./State";
import type { Token } from "./Tokens";
import type { DecompileResult } from "../workers/decompile/types";
import { formatJavaClassName, formatJavaMethodName, formatMethodSignature } from "../utils/JavaDescriptors";

export interface ReferenceSearchState {
    status: "idle" | "loading" | "success" | "error";
    query: string;
    results: ReferenceString[];
    error?: string;
}

export const referenceSearchState = combineLatest([referencesQuery, referencesRequestNonce]).pipe(
    switchMap(([query]) => {
        if (!query) {
            return of<ReferenceSearchState>({
                status: "idle",
                query: "",
                results: []
            });
        }

        return jarIndex.pipe(
            switchMap((index) => from(index.getReference(query)).pipe(
                map((results) => ({
                    status: "success" as const,
                    query,
                    results
                })),
                startWith({
                    status: "loading" as const,
                    query,
                    results: []
                }),
                catchError((error: unknown) => of({
                    status: "error" as const,
                    query,
                    results: [],
                    error: error instanceof Error ? error.message : String(error)
                }))
            ))
        );
    })
);

export const referenceResults = referenceSearchState.pipe(
    map((state) => state.results)
);

export const isViewingReferences = referencesQuery.pipe(
    map((query) => query.length > 0)
);

export function getReferenceQueryForToken(token: Token): ReferenceKey | null {
    switch (token.type) {
        case "class":
            return token.className;
        case "field":
            return `${token.className}:${token.name}:${token.descriptor}`;
        case "method":
            return `${token.className}:${token.name}:${token.descriptor}`;
        default:
            return null;
    }
}

// Format the reference string to be displayed by the user
export function formatReference(reference: ReferenceString): string {
    if (reference.startsWith("m:")) {
        const parts = reference.slice(2).split(":");
        const ownerClassName = parts[0];
        const methodName = formatJavaMethodName(parts[1], ownerClassName);
        if (parts[1] === "<clinit>") {
            return methodName;
        }
        return `${methodName}${formatMethodSignature(parts[2], { simpleNames: true, includeReturnType: false })}`;
    }
    if (reference.startsWith("f:")) {
        const parts = reference.slice(2).split(":");
        return parts[1].replace(/\$/g, ".");
    }
    if (reference.startsWith("c:")) {
        return formatJavaClassName(reference.slice(2), true);
    }
    return reference;
}

export function formatReferenceQuery(query: ReferenceKey): string {
    const type = getQueryType(query);

    switch (type) {
        case "class":
            return formatJavaClassName(query, true);
        case "method": {
            const parts = query.split(":");
            const className = formatJavaClassName(parts[0], true);
            const methodName = formatJavaMethodName(parts[1], parts[0]);
            if (parts[1] === "<clinit>") {
                return `${className}.${methodName}`;
            }
            return `${className}.${methodName}${formatMethodSignature(parts[2], { simpleNames: true, includeReturnType: false })}`;
        }
        case "field": {
            const parts = query.split(":");
            const className = formatJavaClassName(parts[0], true);
            return `${className}.${parts[1].replace(/\$/g, ".")}`;
        }
    }
}

function getQueryType(query: ReferenceKey): "class" | "method" | "field" {
    if (query.includes(":")) {
        const parts = query.split(":");
        if (parts[2].includes("(")) {
            return "method";
        } else {
            return "field";
        }
    }
    return "class";
}

interface ReferenceNavigation {
    // The class to navigate to
    className: string;
    // The reference being navigated to
    query: ReferenceKey;
    // The location of where the reference is found
    reference: ReferenceString;
}

export const nextReferenceNavigation = new BehaviorSubject<ReferenceNavigation | undefined>(undefined);

export function goToReference(query: ReferenceKey, reference: ReferenceString) {
    const className = reference.slice(2).split(":")[0].split('$')[0];
    openTab(className + ".class");

    if (reference.startsWith("c:")) {
        // Nothing to jump to
        return;
    }

    nextReferenceNavigation.next({ className, query, reference });
}

export function findReferenceToken(query: ReferenceKey, reference: ReferenceString, decompileResult: DecompileResult): Token | undefined {
    // This works by first finding the token that matches the reference we are looking for.
    // We can then find the token that matches the declaration of the query we are looking for.
    // This allows us to jump to the first reference of the query after the reference that was selected.

    let referenceTokenIndex: number | null = null;

    { // First find the reference token
        const parts = reference.slice(2).split(":");
        const classname = parts[0];
        const name = parts[1];
        const descriptor = parts[2];
        const expectedType = reference.startsWith("m:") ? "method" : "field";

        for (let i = 0; i < decompileResult.tokens.length; i++) {
            const token = decompileResult.tokens[i];

            if (!token.declaration) {
                // We only want to jump to the declaration
                continue;
            }

            if (token.type != expectedType) {
                continue;
            }

            if (token.className == classname && token.name == name && token.descriptor == descriptor) {
                if (token.type == "field") {
                    // For fields, just return the reference as there is only one declaration
                    return token;
                }

                // For methods we can keep looking for a token that matches the query after this
                referenceTokenIndex = i;
                break;
            }
        }
    }

    if (!referenceTokenIndex) {
        console.log("Could not find reference token for", reference);
        return undefined;
    }

    const parts = query.split(":");
    const name = parts[1];
    const descriptor = parts[2];
    const queryType = getQueryType(query);

    // Next continue searching from the reference token index to find the actual reference
    for (let i = referenceTokenIndex + 1; i < decompileResult.tokens.length; i++) {
        const token = decompileResult.tokens[i];

        // Special case for constructor reference
        if (name == "<init>" && token.type == "class" && token.className == parts[0]) {
            return token;
        }

        if (queryType == "class" && token.type == "class" && token.className == query) {
            return token;
        }

        if (queryType == "method" && token.type == "method" && token.name == name && token.descriptor == descriptor) {
            return token;
        }

        if (queryType == "field" && token.type == "field" && token.name == name) {
            return token;
        }
    }

    // Give up if we reach another declaration, it means we didnt find it
    // Just return the declaration that supposedly contains the reference
    console.log("Could not find token for", query);
    return decompileResult.tokens[referenceTokenIndex];
}

export function getNextJumpToken(decompileResult: DecompileResult): Token | undefined {
    const referenceNavigation = nextReferenceNavigation.getValue();

    if (!referenceNavigation) {
        return undefined;
    }

    const { className, query, reference } = referenceNavigation;

    if (decompileResult.className != className) {
        console.log("Decompile result class does not match reference navigation class", decompileResult.className, className);
        return undefined;
    }

    nextReferenceNavigation.next(undefined);
    return findReferenceToken(query, reference, decompileResult);
}
