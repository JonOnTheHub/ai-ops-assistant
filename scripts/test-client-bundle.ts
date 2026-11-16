// Walks the import graph of the browser-side code and fails if anything
// server-only is reachable from it. A full `next build` is the real proof, but
// this catches the mistake that matters (a client component importing a module
// that pulls in an API SDK or a secret) in a second, on every test run.
//   npx tsx scripts/test-client-bundle.ts

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
    if (condition) {
        console.log(`PASS  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}`);
        if (detail !== undefined) console.log("      got:", typeof detail === "string" ? detail : JSON.stringify(detail));
    }
}

// Packages and built-ins that must never be reachable from code that ships to the browser.
const SERVER_ONLY = ["groq-sdk", "@supabase/supabase-js", "resend", "voyageai", "next/server", "next/headers", "fs", "path", "child_process", "crypto"];

function resolveLocal(from: string, spec: string): string | null {
    const base = spec.startsWith("@/") ? resolve(ROOT, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
    if (!base) return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
        if (existsSync(candidate) && /\.(ts|tsx)$/.test(candidate)) return candidate;
    }
    return null;
}

function walk(entry: string) {
    const files = new Set<string>();
    const packages = new Set<string>();
    const queue = [entry];

    while (queue.length > 0) {
        const file = queue.pop() as string;
        if (files.has(file)) continue;
        files.add(file);

        const source = readFileSync(file, "utf8");
        // import ... from "x", export ... from "x", import "x"  (type-only imports are erased, so skip them)
        for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
            const spec = match[1] ?? match[2];
            const local = resolveLocal(file, spec);
            if (local) queue.push(local);
            else if (!spec.startsWith("@/") && !spec.startsWith(".")) packages.add(spec.startsWith("node:") ? spec.slice(5) : spec);
        }
    }
    return { files: [...files].map((f) => relative(ROOT, f).replace(/\\/g, "/")), packages: [...packages] };
}

for (const entry of ["components/DraftEditor.tsx", "app/page.tsx"]) {
    const graph = walk(resolve(ROOT, entry));
    const leaked = graph.packages.filter((p) => SERVER_ONLY.some((bad) => p === bad || p.startsWith(`${bad}/`)));
    console.log(`\n      ${entry}: ${graph.files.length} local files, ${graph.packages.length} packages`);

    check(`${entry}: no server-only package is reachable from it`, leaked.length === 0, leaked);
    check(`${entry}: it never reaches the Groq-backed refine module`, !graph.files.includes("lib/agent/refine.ts"), graph.files);
    check(`${entry}: it never reaches anything under app/api`, !graph.files.some((f) => f.startsWith("app/api/")), graph.files.filter((f) => f.startsWith("app/api/")));
    check(`${entry}: it never reaches the database or email tools`, !graph.files.some((f) => /^lib\/(tools|supabase|tracing)/.test(f) || f === "lib/agent/executor.ts"), graph.files.filter((f) => /^lib\/(tools|supabase|tracing)/.test(f)));
}

const editor = walk(resolve(ROOT, "components/DraftEditor.tsx"));
check("the editor uses the browser-safe refine helpers", editor.files.includes("lib/agent/refineShared.ts"), editor.files);
check("the editor's whole local graph is small and pure", editor.files.every((f) => ["components/DraftEditor.tsx", "lib/agent/draftEdit.ts", "lib/agent/draftText.ts", "lib/agent/refineShared.ts"].includes(f)), editor.files);

// The walker itself must be able to see a leak, or this test proves nothing.
const planted = walk(resolve(ROOT, "app/api/actions/[id]/refine/route.ts"));
check("self-test: the walker DOES see the server module's Groq SDK when started from the server route", planted.packages.includes("groq-sdk") && planted.files.includes("lib/agent/refine.ts"), planted.packages);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);