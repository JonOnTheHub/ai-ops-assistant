// Real calibration-core, fed the three real debug-retrieval runs from Oct 19
// (the percentages are copied from the output, rounded as printed). It checks
// the scoring maths, and it records the evidence that the current rule is too
// lenient. No network. Run:
//   npx tsx scripts/test-kb-calibration.ts

import { buildRules, scoreAll, scoreRule, recommend, strength, type CalItem } from "./calibration-core";

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

function both(query: string, source: string, v: number, f: number, currentConfident: boolean, relevant: boolean): CalItem {
    return { query, source, foundBy: "both", vectorRatio: v, fulltextRatio: f, currentConfident, relevant };
}

function vectorOnly(query: string, source: string, v: number, currentConfident: boolean, relevant: boolean): CalItem {
    return { query, source, foundBy: "vector", vectorRatio: v, fulltextRatio: null, currentConfident, relevant };
}

// The top 5 results the app returned for each query, as printed by debug-retrieval.
const FUEL = "fuel card receipts missing investigation procedure";
const RETAINER_A = "what's our retainer pricing";
const RETAINER_B = "retainer pricing";

const items: CalItem[] = [
    both(FUEL, "logistics-policy.md (fuel procedure)", 1.0, 1.0, true, true),
    both(FUEL, "logistics-policy.md (fleet overview)", 0.49, 0.23, false, false),
    both(FUEL, "vendor-management-policy.md (onboarding)", 0.58, 0.23, true, false),
    both(FUEL, "logistics-policy.md (equipment inventory)", 0.47, 0.23, false, false),
    vectorOnly(FUEL, "logistics-policy.md (breakdown)", 0.53, false, false),

    both(RETAINER_A, "retainer-policy.md", 1.0, 1.0, true, true),
    both(RETAINER_A, "agency-identity.md", 0.51, 0.62, true, false),
    both(RETAINER_A, "vendor-management-policy.md (contract renewal)", 0.69, 0.5, true, false),
    both(RETAINER_A, "client-escalation-policy.md (tier 3)", 0.49, 0.5, true, false),
    both(RETAINER_A, "client-escalation-policy.md (channels)", 0.46, 0.5, true, false),

    both(RETAINER_B, "retainer-policy.md", 1.0, 1.0, true, true),
    both(RETAINER_B, "vendor-management-policy.md (contract renewal)", 0.55, 0.5, true, false),
    both(RETAINER_B, "client-escalation-policy.md (channels)", 0.54, 0.5, true, false),
    both(RETAINER_B, "client-escalation-policy.md (tier 3)", 0.42, 0.5, true, false),
    vectorOnly(RETAINER_B, "catering-policy.md (budget bands)", 0.9, false, false),
];

const scores = scoreAll(items);
const byName = (name: string) => scores.find((s) => s.rule.name === name);
const current = byName("current rule (as shipped)");
const at = (pctValue: number) => byName(`dual-leg strength >= ${pctValue}%`);

console.log("\n      the evidence, 15 results across 3 real queries (3 are actually relevant):");
console.log("      rule                           TP  FP  FN   precision  recall");
for (const s of scores) {
    console.log(
        `      ${s.rule.name.padEnd(30)} ${String(s.tp).padStart(2)}  ${String(s.fp).padStart(2)}  ${String(s.fn).padStart(2)}   ${s.precision === null ? "   n/a" : (s.precision * 100).toFixed(0).padStart(5) + "%"}   ${s.recall === null ? "n/a" : (s.recall * 100).toFixed(0) + "%"}`
    );
}
console.log("");

// ── the bug, as numbers ──────────────────────────────────────────────────────
check("the current rule labels 11 of the 15 results confident", (current?.tp ?? 0) + (current?.fp ?? 0) === 11, current);
check("...but only 3 of those 11 are actually relevant", current?.tp === 3 && current?.fp === 8, current);
check("so the current rule's precision is about 27%", Math.abs((current?.precision ?? 0) - 3 / 11) < 1e-9, current?.precision);
check("it never misses a relevant chunk on this sample (recall 100%)", current?.recall === 1, current?.recall);

// ── the maths ────────────────────────────────────────────────────────────────
check("the 50% rule reproduces the shipped labels exactly (same structure, same constant)", items.every((i) => buildRules()[1].confident(i) === i.currentConfident));
check("strength is the stronger of the two legs", strength(items[7]) === 0.69 && strength(items[1]) === 0.49);
check("a leg that didn't find the chunk counts as 0, not as missing data", strength(items[4]) === 0.53);
check("raising the threshold never adds confident labels", scores.filter((s) => s.rule.theta !== null).every((s, i, all) => i === 0 || s.tp + s.fp <= all[i - 1].tp + all[i - 1].fp));
check("single-leg chunks keep their margin-based label whatever the threshold", at(95)?.rule.confident(items[4]) === false && at(95)?.rule.confident(items[14]) === false);

// ── what the sample says about where the line is ─────────────────────────────
check("65% still lets one irrelevant chunk through (vendor renewal sits at 69%)", at(65)?.fp === 1, at(65));
check("70% removes every false 'confident' on this sample", at(70)?.fp === 0, at(70));
check("...and keeps all 3 relevant chunks confident", at(70)?.tp === 3 && at(70)?.recall === 1, at(70));
check("anything up to 95% is equally clean here (the sample can't narrow it further)", [70, 75, 80, 85, 90, 95].every((p) => at(p)?.fp === 0 && at(p)?.tp === 3));

const rec = recommend(scores);
check("recommend() picks the lowest clean threshold", rec?.rule.theta === 0.7, rec?.rule.name);
check("recommend() ignores the baseline row", rec?.rule.theta !== null);

// ── edge cases ───────────────────────────────────────────────────────────────
check("no items -> precision and recall are n/a, not NaN", scoreRule([], buildRules()[0]).precision === null && scoreRule([], buildRules()[0]).recall === null);
const noneRelevant = [both("q", "a", 0.9, 0.9, true, false)];
check("when nothing is relevant, recall is n/a and every confident label is a false positive", scoreRule(noneRelevant, buildRules()[0]).recall === null && scoreRule(noneRelevant, buildRules()[0]).fp === 1);
check("recommend() with no clean option falls back to the best F1 instead of crashing", recommend(scoreAll([both("q", "a", 1, 1, true, false), both("q", "b", 1, 1, true, true)])) !== null);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);