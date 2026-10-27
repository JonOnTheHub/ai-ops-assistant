// Real calibration-core, fed the three real debug-retrieval runs from Oct 19
// (the percentages are copied from the output, rounded as printed). It checks
// the scoring maths, and it records the evidence that the current rule is too
// lenient. No network. Run:
//   npx tsx scripts/test-kb-calibration.ts

import { readFileSync } from "node:fs";
import { buildRules, scoreAll, scoreRule, recommend, strength, analyzeFloor, floorOutcome, type CalItem, type QueryTop } from "./calibration-core";

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

// ── Jon's real calibration run, Oct 25 (105 results, 21 queries) ─────────────
// scripts/fixtures/calibration-2026-10-25.txt is the run's output with chunk
// text trimmed. The "current" flag in it is what the OLD rule (either leg >= 50%
// of its own #1) said at the time, which is what this evidence is about.
interface Parsed {
    item: CalItem;
    queryIndex: number;
    rank: number;
}

function parseFixture(file: string): Parsed[] {
    const out: Parsed[] = [];
    let queryIndex = 0;
    let query = "";
    const ratio = (token: string) => (token === "-" ? null : Number(token.replace("%", "")) / 100);

    for (const line of readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8").split(/\r?\n/)) {
        const header = line.match(/^\[(\d+)\/\d+\] "(.*)"/);
        if (header) {
            queryIndex = Number(header[1]);
            query = header[2];
            continue;
        }
        const m = line.match(/^\s+(\d)\.\s+(CONFIDENT|weak)\s+\[(relevant|not relev\.)\s*\]\s+vec\s+(\S+)\s+txt\s+(\S+)\s+(\S+)/);
        if (!m) continue;
        const vectorRatio = ratio(m[4]);
        const fulltextRatio = ratio(m[5]);
        out.push({
            queryIndex,
            rank: Number(m[1]),
            item: {
                query,
                source: m[6],
                foundBy: vectorRatio !== null && fulltextRatio !== null ? "both" : vectorRatio !== null ? "vector" : "fulltext",
                vectorRatio,
                fulltextRatio,
                currentConfident: m[2] === "CONFIDENT",
                relevant: m[3] === "relevant",
            },
        });
    }
    return out;
}

const parsed = parseFixture("calibration-2026-10-25.txt");
// Four results my regex labels called "not relevant" are plainly on-topic
// answers (a Tier 2 complaint chunk for a complaint question, perishable-sourcing
// rules for an imported-ingredients question, the fleet/fuel overview for "fuel",
// the security-staffing overview for a guards question). Scoring them either way
// would just measure my labels, so they are left out.
const AMBIGUOUS = new Set(["15:1", "16:1", "20:1", "6:2"]);
const real = parsed.filter((p) => !AMBIGUOUS.has(`${p.queryIndex}:${p.rank}`)).map((p) => p.item);
const realScores = scoreAll(real);
const realBy = (name: string) => realScores.find((s) => s.rule.name === name);

console.log(`\n      real run: ${parsed.length} parsed, ${real.length} scored, ${real.filter((i) => i.relevant).length} relevant`);
for (const s of realScores) {
    console.log(`      ${s.rule.name.padEnd(34)} TP ${String(s.tp).padStart(2)}  FP ${String(s.fp).padStart(2)}  FN ${String(s.fn).padStart(2)}   precision ${s.precision === null ? "n/a" : (s.precision * 100).toFixed(0) + "%"}   recall ${s.recall === null ? "n/a" : (s.recall * 100).toFixed(0) + "%"}`);
}

// ── what the real run proves ─────────────────────────────────────────────────
const oldRule = realBy("current rule (as shipped)");
const scriptPick = realBy("dual-leg strength >= 95%");
const newRule90 = realBy("both legs + vector >= 90%");
const newRule80 = realBy("both legs + vector >= 80%");

check("fixture: all 105 results parsed, 25 of them relevant", parsed.length === 105 && parsed.filter((p) => p.item.relevant).length === 25, parsed.length);
check("fixture: 4 label-ambiguous results are left out, 101 scored", real.length === 101, real.length);
check("OLD rule: 56 irrelevant results labeled confident, 31% precision", oldRule?.fp === 56 && Math.abs((oldRule?.precision ?? 0) - 25 / 81) < 1e-9, oldRule);
check("OLD rule: never misses a relevant chunk, because it calls nearly everything confident", oldRule?.recall === 1, oldRule?.recall);
check("the earlier script pick (either leg >= 95%) was only 76% precise", scriptPick?.tp === 22 && scriptPick?.fp === 7 && Math.abs((scriptPick?.precision ?? 0) - 22 / 29) < 1e-9, scriptPick);
check("NEW rule (both legs, vector >= 90%): 1 false 'confident' in 101 results", newRule90?.fp === 1, newRule90);
check("NEW rule: 95% precision, 84% recall", Math.abs((newRule90?.precision ?? 0) - 21 / 22) < 1e-9 && Math.abs((newRule90?.recall ?? 0) - 21 / 25) < 1e-9, newRule90);
check("NEW rule gains more than 60 points of precision over the old one", (newRule90?.precision ?? 0) - (oldRule?.precision ?? 0) > 0.6);
check("the 80% variant trades precision for recall (83% / 96%)", newRule80?.tp === 24 && newRule80?.fp === 5, newRule80);
check("recommend() prefers the vector-ratio family over any full-text-inflated threshold", recommend(realScores)?.rule.name.startsWith("both legs + vector") === true, recommend(realScores)?.rule.name);


// ── Oct 26: the second run, with raw best scores for all 23 queries ──────────
const run2 = readFileSync(new URL("./fixtures/calibration-2026-10-26.txt", import.meta.url), "utf8").split(/\r?\n/);
const UNANSWERABLE = new Set(["visa requirements for staff travelling abroad", "what is the company pension plan", "what is the capital of france"]);
const tops: QueryTop[] = [];
{
    let q = "";
    for (const line of run2) {
        const h = line.match(/^\[\d+\/\d+\] "(.*)"/);
        if (h) q = h[1];
        const r = line.match(/raw #1 scores: vector ([0-9.]+)/);
        if (r) tops.push({ query: q, answerable: !UNANSWERABLE.has(q), vectorTop: Number(r[1]) });
    }
}
const floorInfo = analyzeFloor(tops);
const POOR = Number(readFileSync(new URL("../lib/tools/searchKnowledgeBase.ts", import.meta.url), "utf8").match(/MIN_VECTOR_TOP_SCORE\s*=\s*([0-9.]+)/)?.[1]);
const DOUBTFUL = Number(readFileSync(new URL("../lib/tools/searchKnowledgeBase.ts", import.meta.url), "utf8").match(/DOUBTFUL_VECTOR_TOP_SCORE\s*=\s*([0-9.]+)/)?.[1]);
const poorOutcome = floorOutcome(tops, POOR);
const doubtfulOutcome = floorOutcome(tops, DOUBTFUL);

console.log(`\n      run 2: ${tops.length} queries, lowest answerable ${floorInfo.minAnswerable}, highest unanswerable ${floorInfo.maxAbsent}`);
console.log(`      poor tier < ${POOR}: wrongly denies ${poorOutcome.falselyGated.length}, catches ${poorOutcome.correctlyGated.length} of 3`);
console.log(`      doubtful tier < ${DOUBTFUL}: hollow dots on ${doubtfulOutcome.falselyGated.length} answerable, catches ${doubtfulOutcome.correctlyGated.length} of 3\n`);

check("run 2: 23 queries, 20 answerable and 3 not", tops.length === 23 && tops.filter((t) => t.answerable).length === 20, tops.length);
check("run 2: NOT separable by one floor: the on-topic-but-absent 'visa' query (0.337) outscores two answerable ones", !floorInfo.separable && floorInfo.maxAbsent === 0.337 && floorInfo.minAnswerable === 0.3118, floorInfo);
check("...the two answerable ones are 'fuel' and 'imported ingredients approval'", floorOutcome(tops, 0.32).falselyGated.length === 2 && floorOutcome(tops, 0.32).falselyGated.every((q) => q === "fuel" || q === "imported ingredients approval"), floorOutcome(tops, 0.32).falselyGated);
check("a single 0.35 floor used as a DENIAL would have wrongly denied those 2 answerable queries", floorOutcome(tops, 0.35).falselyGated.length === 2);
check("poor tier: wrongly denies NO answerable query", poorOutcome.falselyGated.length === 0, poorOutcome.falselyGated);
check("poor tier: catches both off-topic queries (pension, France)", poorOutcome.correctlyGated.length === 2, poorOutcome.correctlyGated);
check("poor tier: misses only the on-topic-but-absent one (visa), whose dots the doubtful tier hollows", poorOutcome.missedAbsent.length === 1 && poorOutcome.missedAbsent[0].includes("visa"), poorOutcome.missedAbsent);
check("doubtful tier: catches all 3 unanswerable queries", doubtfulOutcome.correctlyGated.length === 3, doubtfulOutcome.correctlyGated);
check("doubtful tier: costs 2 answerable queries a hollow dot, and nothing worse", doubtfulOutcome.falselyGated.length === 2);

// Dots as the app now shows them: a poor or doubtful best match turns every dot
// hollow, whatever the per-item rule said.
const topByQuery = new Map(tops.map((t) => [t.query, t.vectorTop]));
const run2Items = parseFixture("calibration-2026-10-26.txt").map((p) => p.item);
const withTiers: CalItem[] = run2Items.map((i) => ({ ...i, currentConfident: i.currentConfident && (topByQuery.get(i.query) ?? 1) >= DOUBTFUL }));
const sameRule = scoreRule(withTiers, buildRules().find((r) => r.name === "current rule (as shipped)") as never);
console.log(`      shipped rule + tiers on run 2 (115 results, nothing excluded): TP ${sameRule.tp}  FP ${sameRule.fp}  FN ${sameRule.fn}  precision ${((sameRule.precision ?? 0) * 100).toFixed(0)}%  recall ${((sameRule.recall ?? 0) * 100).toFixed(0)}%`);
check("with tiers applied, no unanswerable query shows a solid dot", withTiers.filter((i) => UNANSWERABLE.has(i.query)).every((i) => !i.currentConfident));
check("with tiers applied, the only solid dot on an unlabeled-relevant chunk is the Tier 2 complaint chunk", withTiers.filter((i) => i.currentConfident && !i.relevant).length === 1, withTiers.filter((i) => i.currentConfident && !i.relevant).map((i) => i.query + " -> " + i.source));

// ── drift guard: the shipped constants must still sit inside the evidence ────
const source = readFileSync(new URL("../lib/tools/searchKnowledgeBase.ts", import.meta.url), "utf8");
const shippedRatio = Number(source.match(/DUAL_LEG_VECTOR_RATIO\s*=\s*([0-9.]+)/)?.[1]);
check("poor tier is below EVERY answerable query measured, so it can never deny one", POOR < (floorInfo.minAnswerable ?? 0), POOR);
check("doubtful tier is above EVERY unanswerable query measured, so none keeps a solid dot", DOUBTFUL > (floorInfo.maxAbsent ?? 1), DOUBTFUL);
check("the tiers are ordered", POOR < DOUBTFUL, [POOR, DOUBTFUL]);
check("shipped dual-leg ratio is the 90% one this evidence supports", shippedRatio === 0.9, shippedRatio);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);