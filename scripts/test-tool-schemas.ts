import { TOOL_REGISTRY } from "@/lib/tools";

// Why this exists: gpt-oss-120b sends an explicit null for any optional tool
// parameter it decides to skip. Groq validates that against our JSON schema
// BEFORE our code runs, so a schema that says "type: string" for an optional
// field turns a harmless null into a hard 400 and the whole turn dies.
// TypeScript can't catch it (ToolDefinition.parameters is Record<string,
// unknown>), and it already bit us once per tool because each fix was
// per-tool. This audits every tool at once and walks nested objects/arrays.
//
// Run: npx tsx scripts/test-tool-schemas.ts   (no env, no network)

type Schema = Record<string, unknown>;

function allowsNull(schema: Schema): boolean {
    const type = schema.type;
    const typeOk = Array.isArray(type) && type.includes("null");
    const values = schema.enum;
    const enumOk = !Array.isArray(values) || values.includes(null);
    return typeOk && enumOk;
}

export function findNonNullableOptionals(schema: Schema, path: string): string[] {
    const problems: string[] = [];
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

    for (const [key, prop] of Object.entries(properties)) {
        const here = `${path}.${key}`;
        if (!required.includes(key) && !allowsNull(prop)) problems.push(here);
        problems.push(...findNonNullableOptionals(prop, here));
        if (prop.items && typeof prop.items === "object") {
            problems.push(...findNonNullableOptionals(prop.items as Schema, `${here}[]`));
        }
    }

    return problems;
}

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
    if (condition) {
        console.log(`PASS  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}`);
        if (detail !== undefined) console.log("      ", detail);
    }
}

// ── Self-test: prove the checker itself detects each kind of violation ──
const bad: Schema = {
    type: "object",
    required: ["must"],
    properties: {
        must: { type: "string" },
        plain: { type: "string" },
        enumNoNull: { type: ["string", "null"], enum: ["a", "b"] },
        nested: {
            type: ["object", "null"],
            required: [],
            properties: { inner: { type: "string" } },
        },
        list: {
            type: ["array", "null"],
            items: { type: "object", required: [], properties: { deep: { type: "string" } } },
        },
    },
};
const found = findNonNullableOptionals(bad, "bad");
check("self-test: required field is NOT flagged", !found.includes("bad.must"), found);
check("self-test: optional plain string is flagged", found.includes("bad.plain"), found);
check("self-test: nullable type with an enum lacking null is flagged", found.includes("bad.enumNoNull"), found);
check("self-test: optional inside a nested object is flagged", found.includes("bad.nested.inner"), found);
check("self-test: optional inside array items is flagged", found.includes("bad.list[].deep"), found);

const good: Schema = {
    type: "object",
    required: ["must"],
    properties: {
        must: { type: "string" },
        fine: { type: ["string", "null"] },
        fineEnum: { type: ["string", "null"], enum: ["a", null] },
    },
};
check("self-test: a correct schema produces no problems", findNonNullableOptionals(good, "good").length === 0, findNonNullableOptionals(good, "good"));

// ── The real audit: every tool in the registry ──
for (const tool of Object.values(TOOL_REGISTRY)) {
    const problems = findNonNullableOptionals(tool.parameters, tool.name);
    check(
        `${tool.name}: every optional parameter accepts null`,
        problems.length === 0,
        problems.length ? `not null-tolerant: ${problems.join(", ")}` : undefined
    );
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);