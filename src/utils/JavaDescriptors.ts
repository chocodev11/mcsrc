interface FormatTypeOptions {
    simpleNames?: boolean;
}

interface FormatMethodSignatureOptions extends FormatTypeOptions {
    includeReturnType?: boolean;
}

const primitiveTypeMap: Record<string, string> = {
    V: "void",
    Z: "boolean",
    B: "byte",
    C: "char",
    S: "short",
    I: "int",
    J: "long",
    F: "float",
    D: "double"
};

function simplifyJavaType(typeName: string): string {
    const cleaned = typeName.replace(/\//g, ".").replace(/\$/g, ".");
    const parts = cleaned.split(".");
    if (parts.length === 0) {
        return cleaned;
    }

    const last = parts[parts.length - 1];
    const parent = parts[parts.length - 2];
    if (parent && /^[A-Z]/.test(parent) && /^[A-Z]/.test(last)) {
        return `${parent}.${last}`;
    }
    return last;
}

function formatObjectType(internalName: string, simpleNames: boolean): string {
    const dotName = internalName.replace(/\//g, ".").replace(/\$/g, ".");
    return simpleNames ? simplifyJavaType(dotName) : dotName;
}

function parseJvmType(descriptor: string, startIndex: number, simpleNames: boolean): [string, number] {
    let index = startIndex;
    let arrayDepth = 0;

    while (descriptor[index] === "[") {
        arrayDepth++;
        index++;
    }

    let typeName: string;
    if (descriptor[index] === "L") {
        const endIndex = descriptor.indexOf(";", index);
        typeName = formatObjectType(descriptor.slice(index + 1, endIndex), simpleNames);
        index = endIndex + 1;
    } else {
        typeName = primitiveTypeMap[descriptor[index]] || descriptor[index];
        index++;
    }

    return [`${typeName}${"[]".repeat(arrayDepth)}`, index];
}

export function formatJavaType(descriptor: string, options: FormatTypeOptions = {}): string {
    const [typeName] = parseJvmType(descriptor, 0, options.simpleNames ?? false);
    return typeName;
}

export function formatMethodSignature(descriptor: string, options: FormatMethodSignatureOptions = {}): string {
    const simpleNames = options.simpleNames ?? false;
    const includeReturnType = options.includeReturnType ?? true;

    if (!descriptor.startsWith("(")) {
        return formatJavaType(descriptor, { simpleNames });
    }

    const endParams = descriptor.indexOf(")");
    const paramsDescriptor = descriptor.slice(1, endParams);
    const returnDescriptor = descriptor.slice(endParams + 1);

    const params: string[] = [];
    let index = 0;
    while (index < paramsDescriptor.length) {
        const [typeName, nextIndex] = parseJvmType(paramsDescriptor, index, simpleNames);
        params.push(typeName);
        index = nextIndex;
    }

    if (!includeReturnType) {
        return `(${params.join(", ")})`;
    }

    const [returnType] = parseJvmType(returnDescriptor, 0, simpleNames);
    return `(${params.join(", ")}) → ${returnType}`;
}

export function formatJavaClassName(className: string, simpleNames = false): string {
    const dotName = className.replace(/\//g, ".").replace(/\$/g, ".");
    return simpleNames ? simplifyJavaType(dotName) : dotName;
}

export function formatJavaMethodName(name: string, ownerClassName?: string): string {
    if (name === "<clinit>") {
        return "static initializer";
    }

    if (name === "<init>") {
        return ownerClassName ? formatJavaClassName(ownerClassName, true) : "constructor";
    }

    const lambdaMatch = /^lambda\$(.+?)\$\d+$/.exec(name);
    if (lambdaMatch) {
        return `lambda ${lambdaMatch[1]}`;
    }

    return name.replace(/\$/g, ".");
}
