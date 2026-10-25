// Pure logic for calibrating the retrieval confidence rule. No network, no DB,
// so it can be tested exactly. scripts/calibrate-confidence.ts feeds it real
// retrieval results; scripts/test-kb-calibration.ts feeds it real results
// copied from debug-retrieval runs.
//
// The rule today (searchKnowledgeBase.ts): a chunk found by BOTH legs is
// "confident" if at least one leg's raw score is >= SCORE_RATIO_THRESHOLD of
// that same leg's own #1 score. A chunk found by one leg is judged by its
// margin over the next result instead. Calibrating means asking: at what
// threshold do "confident" and "actually relevant" line up best?

export interface CalItem {
    query: string;
    source: string;
    foundBy: "both" | "vector" | "fulltext";
    // Each leg's raw score for this chunk as a fraction of THAT leg's #1.
    vectorRatio: number | null;
    fulltextRatio: number | null;
    // What the app's real rule labels it today.
    currentConfident: boolean;
    // Ground truth: does this chunk actually answer the query?
    relevant: boolean;
}

export interface Rule {
    name: string;
    // The threshold for the ratio family, null for the "current" baseline.
    theta: number | null;
    confident: (item: CalItem) => boolean;
}

export interface RuleScore {
    rule: Rule;
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number | null;
    recall: number | null;
}

export function strength(item: CalItem): number {
    return Math.max(item.vectorRatio ?? 0, item.fulltextRatio ?? 0);
}

export const THETAS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

// Only the dual-leg strength threshold changes. Single-leg chunks keep the
// existing margin-based label, so each candidate is exactly "the current
// design with a different constant", not a new design.
export function buildRules(): Rule[] {
    const rules: Rule[] = [
        { name: "current rule (as shipped)", theta: null, confident: (item) => item.currentConfident },
    ];

    for (const theta of THETAS) {
        rules.push({
            name: `dual-leg strength >= ${Math.round(theta * 100)}%`,
            theta,
            confident: (item) => (item.foundBy === "both" ? strength(item) >= theta : item.currentConfident),
        });
    }

    return rules;
}

export function scoreRule(items: CalItem[], rule: Rule): RuleScore {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;

    for (const item of items) {
        const confident = rule.confident(item);
        if (confident && item.relevant) tp++;
        else if (confident && !item.relevant) fp++;
        else if (!confident && item.relevant) fn++;
        else tn++;
    }

    return {
        rule,
        tp,
        fp,
        fn,
        tn,
        precision: tp + fp === 0 ? null : tp / (tp + fp),
        recall: tp + fn === 0 ? null : tp / (tp + fn),
    };
}

export function scoreAll(items: CalItem[]): RuleScore[] {
    return buildRules().map((rule) => scoreRule(items, rule));
}

// The lowest threshold that produces no false "confident" labels while
// keeping as much recall as any zero-false-positive threshold can. If none is
// clean, the one with the best F1. Lowest-clean-threshold on purpose: it is
// the least aggressive change that fixes the labeling.
export function recommend(scores: RuleScore[]): RuleScore | null {
    const candidates = scores.filter((s) => s.rule.theta !== null);
    if (candidates.length === 0) return null;

    const clean = candidates.filter((s) => s.fp === 0);
    if (clean.length > 0) {
        const bestRecall = Math.max(...clean.map((s) => s.recall ?? 0));
        return clean.find((s) => (s.recall ?? 0) === bestRecall) ?? null;
    }

    const f1 = (s: RuleScore) => {
        const p = s.precision ?? 0;
        const r = s.recall ?? 0;
        return p + r === 0 ? 0 : (2 * p * r) / (p + r);
    };
    return candidates.reduce((best, s) => (f1(s) > f1(best) ? s : best), candidates[0]);
}

export function pct(value: number | null): string {
    return value === null ? "  n/a" : `${(value * 100).toFixed(0).padStart(4)}%`;
}