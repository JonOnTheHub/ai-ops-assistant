import { createClient } from "@supabase/supabase-js";
import { embed } from "@/lib/embeddings";

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Chunking strategy: split by paragraph, not by word count. These
// documents were written with one topic per paragraph on purpose — the
// original word-count chunker ignored that structure and could glue
// several unrelated topics into a single chunk (e.g. supplier vetting +
// international sourcing + dietary rules all in one ~500-word block).
// That dilutes the embedding: a narrow query like "fuel card
// reconciliation" competes against the chunk's overall multi-topic gist
// instead of the one paragraph that actually answers it. Splitting on
// paragraph boundaries (a document's own structure) keeps each chunk's
// embedding focused on a single fact, which is what confidence signaling
// actually needs to work.
//
// A very long single paragraph still gets sub-split at WORDS_PER_CHUNK
// as a safety net, but none of the current documents' paragraphs are
// anywhere near that size.
const WORDS_PER_CHUNK = 350;

function chunk(content: string): string[] {
    const paragraphs = content
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

    const chunks: string[] = [];

    for (const paragraph of paragraphs) {
        const words = paragraph.split(/\s+/);
        if (words.length <= WORDS_PER_CHUNK) {
            chunks.push(paragraph);
        } else {
            for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
                chunks.push(words.slice(i, i + WORDS_PER_CHUNK).join(" "));
            }
        }
    }

    return chunks;
}

const DOCUMENTS: { source: string; content: string }[] = [
    {
        source: "catering-policy.md",
        content: `Solmara Studio's catering standards apply to every event we design, whether we are directly sourcing food ourselves or coordinating a client's independently chosen caterer. These standards exist to protect both guest safety and the studio's reputation for consistent, high-end execution, and they apply equally to a 40-guest intimate dinner and a 500-guest wedding.

Supplier vetting: any perishable ingredient — seafood, dairy, fresh produce, raw meat — must be sourced through a vetted supplier on the approved list maintained by Catering and Vendor Management jointly. Vetting requires a food safety certificate issued within the last 12 months, at least two verifiable references from prior commercial (not residential) clients, and a documented cold-chain capability if the supplier handles anything requiring refrigerated transport. A supplier failing any of these three checks may still be used on a one-time exception basis, but only with sign-off from both the Catering lead and Vendor Management, logged as an exception in the vendor file.

International and specialty sourcing: for briefs calling for imported or specialty ingredients — a named example is the Swiss tilapia supplier used for the Kumasi wedding brief — the sourcing process requires Finance sign-off whenever the per-item cost exceeds ₦150,000, and Logistics must independently confirm that cold-chain transport is viable for the full duration between origin and event, not just origin to Lagos. An international order that cannot be confirmed cold-chain-viable by Logistics is not to proceed regardless of client enthusiasm or timeline pressure — Catering should propose a comparable local or regional substitute in that case, framed to the client as a quality-preserving decision, not a cost-cutting one.

Dietary accommodation is mandatory, not a premium add-on. Every menu proposal must default to including at minimum one vegetarian option and one halal-prepared option unless the client has explicitly waived this in writing during intake. Allergy information is collected from the client at intake and must be cross-checked against the finalized menu no later than 5 business days before the event date. Every dish containing a declared allergen must be clearly labeled at the service line, with a substitute available on request without delay — guests should never be told to "just avoid" a section of the table.

Budget bands: cocktail-style service runs ₦18,000–₦35,000 per head; a seated multi-course dinner runs ₦25,000–₦60,000 per head; bespoke tasting menus or imported-ingredient-heavy briefs scale above this band and require an itemized quote reviewed by Finance before being presented to the client. Any quote exceeding ₦75,000 per head requires a second Catering-lead review before it goes out, regardless of who drafted it.

Waste tolerance is capped at 10% of prepared quantity per event, measured against the guaranteed guest count provided by the client 72 hours before the event. A caterer — internal team or external vendor — exceeding this threshold on two consecutive events is flagged automatically for a sourcing-and-quantity audit before their next booking is confirmed; this is a process safeguard, not a punitive measure, and should be communicated to the caterer as such.

Event-day staffing ratio for catering service (distinct from security staffing) is 1 catering staff member per 20 guests for plated service, and 1 per 35 guests for buffet or cocktail-style service. Setup and breakdown crews may be smaller than service-hour staffing, but service-hour staffing must be confirmed present and briefed no later than 60 minutes before doors open to guests.

Any last-minute menu change requested by the client inside the 5-business-day allergy-check window must be escalated to the Catering lead directly rather than absorbed silently by whoever receives the request — late changes carry real allergy and sourcing risk and should never be treated as routine.`,
    },
    {
        source: "logistics-policy.md",
        content: `Solmara Studio maintains a small company-owned fleet used for equipment transport, vendor pickups, and staff movement between venues. This policy governs vehicle use, maintenance, fuel handling, and load-in/load-out timing for every event the studio runs.

Fuel and vehicle-use procedure: fuel costs for company-owned vehicles are covered on a card issued and reconciled by Finance. Drivers are required to log odometer readings at both the start and end of every trip, and to retain physical or photographed fuel receipts for monthly reconciliation — a trip logged without both readings is treated as unreconciled until the driver supplies them, and repeated unreconciled trips are escalated to the Logistics lead. Any vehicle exception for a specific task — a vehicle excluded from an assignment, reserved elsewhere, or under maintenance — must be stated explicitly in the task brief itself; Logistics does not assume a vehicle is available by default just because it is not named as excluded, and does not assume a vehicle is excluded just because it wasn't explicitly listed as available. When in doubt, Logistics confirms with the task originator before dispatching.

Maintenance scheduling: every fleet vehicle is serviced at 5,000km intervals or every 3 months, whichever comes first. No vehicle may be dispatched on an event-day run if its next scheduled service is more than 500km overdue — this applies even under time pressure, since a breakdown mid-transport on event day is a far larger operational risk than a short-notice rental. If a needed vehicle is over its maintenance threshold, Logistics arranges a short-term rental rather than dispatching it, and flags the affected vehicle for immediate servicing.

Load-in and load-out timing scales with event size. For events under 150 guests, equipment transport must arrive on-site no later than 3 hours before the client's stated start time. For events between 150 and 300 guests, the buffer extends to 4 hours. For events exceeding 300 guests, the buffer extends to 5 hours, and Logistics should plan for a second transport run as a contingency rather than relying on a single fully-loaded trip. These buffers are minimums, not targets — arriving earlier is always acceptable, arriving later requires prior escalation to Events Coordination, not a same-day explanation after the fact.

Vendor delivery coordination: delivery windows for third-party vendors (rentals, decor, specialty catering items) should be confirmed 48 hours in advance and reconfirmed again the morning of the event. Any delivery delay expected to exceed 30 minutes past its confirmed window must be escalated immediately to Events Coordination — not held until the next scheduled check-in point. Escalating late, even if the delay itself was unavoidable, is treated as a process failure separate from the delay itself, because it removes Events Coordination's ability to adjust the run-sheet in time.

Equipment inventory is audited monthly: every reusable item (tables, linens, AV equipment, decor pieces) is checked against the studio's inventory log, and discrepancies above 5% of any single category trigger a full recount before the next event using that category is booked. Damaged or missing equipment identified post-event must be logged within 48 hours of the event's conclusion, not held for the monthly audit cycle, so replacement or repair can be arranged before the next booking needs it.

Emergency breakdown protocol: if a vehicle breaks down in transit on event day, the driver contacts the Logistics lead immediately, not Events Coordination directly — Logistics then makes the call on whether to dispatch a backup vehicle or request Events Coordination adjust the run-sheet, since Logistics has the clearest picture of remaining fleet capacity in the moment.`,
    },
    {
        source: "security-policy.md",
        content: `Security staffing and protocol scale with both guest count and event sensitivity. These ratios are minimums; Client Relations may request higher staffing for a specific brief, subject to Finance approval if the request pushes the event over its allocated security budget line.

Staffing ratios: 1 security staff member per 75 guests for a standard event with no special sensitivity. This tightens to 1 per 40 guests for any event involving a high-profile or public-facing client — defined as a client whose attendance or event details carry meaningful media or reputational visibility. It tightens further to 1 per 25 guests for any event with a restricted-access zone: VIP lounges, gift or valuables tables, backstage or greenroom areas, or any area the client has specifically flagged as needing controlled entry.

Credentialing: any event exceeding 150 guests requires visible Solmara-issued badges for all staff, vendors, and contracted crew for the full duration of setup, service, and breakdown — no exceptions for "just picking something up quickly." Guest-list verification at entry points is mandatory for any event the client has explicitly flagged as invite-only; verification may be waived only with written client sign-off, never on the security lead's own judgment alone.

Incident classification and response: incidents are classified as minor, moderate, or severe at the point of occurrence by the on-site security lead. A minor incident (a guest dispute, a lost item, minor property damage) is logged and resolved on-site, with a written log entry filed within 4 hours of the event's conclusion. A moderate incident (an altercation requiring intervention, unauthorized access to a non-restricted area) requires immediate verbal notification to Events Coordination and a written incident report within 2 hours of occurrence. A severe incident — anything involving guest safety, threat of violence, or unauthorized access to a restricted zone — requires notification to Events Coordination within 15 minutes of occurrence, verbal first, with a written report following within 2 hours, and Studio ownership must be looped in by Events Coordination the same day regardless of how the incident resolved.

Escalation order for any incident above minor severity is strict and sequential: on-site security lead, then Events Coordination lead, then Studio ownership. No step in this sequence is skipped, including in a severe incident — speed within each step matters more than skipping steps.

Venue-owned security coordination: where a venue provides its own security staff in addition to Solmara's, the on-site security lead is responsible for confirming reporting lines and communication protocol with venue security before the event begins, not improvised during an incident. This includes agreeing in advance who has authority to eject a guest, who controls restricted-zone access, and how the two teams will communicate during setup, service, and breakdown.

Staff requirements: all Solmara security staff must hold a current, non-expired security certification recognized in Nigeria, and must complete an internal briefing on the specific event's guest list sensitivities, restricted zones, and escalation contacts no later than 2 hours before doors open. A staff member who has not completed this briefing may not be assigned to a restricted-zone post.`,
    },
    {
        source: "vendor-management-policy.md",
        content: `New vendor onboarding at Solmara Studio requires three things on file before a first booking is confirmed: a signed service agreement, proof of business registration, and — specifically for any vendor handling food, alcohol, or pyrotechnics — a current license or permit appropriate to that category. A vendor missing any of these three is not booked, regardless of how strong the referral or how tight the event timeline.

Performance evaluation runs on a rolling basis after every engagement, scored on a 5-point scale across three criteria: punctuality (arrival and completion against agreed timing), quality-as-briefed (whether delivered work matched the agreed specification), and communication responsiveness (response time to Solmara's requests before and during the engagement). A vendor scoring below 3 on any single criterion is flagged for a follow-up conversation; a vendor scoring below 3 on two consecutive engagements, on any criterion, is moved to a probationary list and requires explicit Vendor Management sign-off before being booked again, even for a client-requested repeat booking.

Payment terms: vendors on the preferred list receive standard net-30 terms from invoice date. New or probationary vendors operate on 50% deposit with net-15 terms on the remaining balance — this protects the studio's cash position against vendors with an unproven track record. Payment terms for a specific engagement may only be adjusted with written approval from Finance; Vendor Management does not have unilateral authority to alter payment terms mid-contract, even to accommodate a vendor's cash-flow request, without that sign-off on file.

Preferred-vendor status is reviewed quarterly against three criteria: a minimum of 3 completed engagements with Solmara, an average performance score of 4.0 or higher across those engagements, and no unresolved disputes in the trailing 6 months. A vendor meeting all three moves to preferred status automatically at the quarterly review; a vendor failing any one criterion remains on standard terms until the next review cycle, regardless of how close they came.

Dispute resolution follows a two-stage process. Stage one: the dispute (billing disagreement, quality complaint, missed delivery) is handled directly by Vendor Management, who documents both the vendor's position and Solmara's position in writing. Stage two: if unresolved within 10 business days of being raised, the dispute escalates to Studio ownership with that written summary attached — Vendor Management does not continue attempting informal resolution past the 10-day mark, since prolonged informal back-and-forth without escalation has historically delayed resolution further.

Category-specific rules apply on top of the general framework above. Catering suppliers are additionally subject to the food-safety certification requirements described in the catering policy. Decor and rental vendors are required to carry their own liability insurance for on-site setup, with proof on file before first booking. AV and technical vendors are required to conduct an on-site equipment check no later than 4 hours before event start, with any equipment failure identified at that check escalated to Events Coordination immediately rather than addressed silently by the vendor alone.

Contract renewal for any vendor on a standing retainer arrangement (rather than per-event booking) is reviewed annually, aligned to the anniversary of the original signed agreement, not on a rolling basis — this keeps renewal timing predictable for both the studio and the vendor.`,
    },
    {
        source: "design-brand-guidelines.md",
        content: `Solmara Studio's default visual identity governs all staff-facing and client-facing materials: uniforms, branded signage, printed collateral, proposal decks, and digital assets. The default studio palette, typography, and logo usage rules are maintained in the studio's central brand kit, and any staff-facing material produced without Design department review is considered non-compliant regardless of intent.

Standard uniforms for staff working a Solmara event use the studio's default design — consistent cut, color, and branding — with no departmental or individual variation permitted without formal sign-off. This exists so that a client and their guests can visually identify Solmara staff at a glance across any event, anywhere.

Culturally-adapted variations are both permitted and encouraged for events specifically requiring them — a destination event calling for region-appropriate fabric, pattern, or styling is the clearest example. Any such variation must go through Design as a formal request rather than being improvised by whichever department is closest to the event. The Kumasi wedding kente-inspired uniform request is the standing reference precedent for how this process should run end to end: a clear written brief describing the occasion and constraints, a defined turnaround for initial concepts (sketches or mood boards delivered within one week of the request being raised), a review and revision pass with the requesting party, and final sign-off before any sourcing or tailoring begins. A variation request that skips the review step — for example, sourcing fabric before sketches are approved — is not to proceed, even under real time pressure, because unwinding a wrong material order costs more time than the review step would have.

Climate and practicality constraints are a required part of any uniform variation brief, not an afterthought Design discovers during production. A brief for a hot-climate destination event should explicitly address fabric breathability and sleeve length; a brief involving prolonged outdoor standing should address footwear practicality. Design should proactively ask for these constraints if a brief omits them, rather than assuming and adjusting later.

Client-facing materials — proposals, mood boards, event signage, printed programs — must carry the Solmara wordmark and follow the brand kit's spacing and color usage rules without exception, including for high-value or long-standing retainer clients. Co-branding (incorporating a client's own branding alongside Solmara's on shared materials) is permitted only where explicitly agreed in the client's contract; absent that explicit contract language, Design defaults to Solmara-only branding even if a client casually requests otherwise mid-project, and refers the request back to Client Relations to formalize in writing first.

Version control for brand assets (logo files, approved color values, uniform specification sheets) lives with Design as the single source of truth. Any department needing a current asset requests it from Design directly rather than reusing a version from a prior event's files, since specifications do get revised — the uniform specification used for a standard local event, for instance, is not automatically the correct base for a climate-adapted variant, even if it looks close enough at a glance.

Photography and social media usage of event materials requires the client's consent as captured at intake, and any image intended for Solmara's own portfolio or marketing use requires a separate, explicit confirmation beyond the general event photography consent — the two are not the same permission.`,
    },
    {
        source: "client-escalation-policy.md",
        content: `Client complaints and concerns at Solmara Studio are triaged into three tiers on intake, and the tier determines both response speed and who owns resolution.

Tier 1 — service friction: a minor delay, a small menu substitution, a scheduling miscommunication, anything that inconveniences without meaningfully damaging the client's experience or trust. Tier 1 requires an acknowledgment response within 4 business hours and a concrete resolution plan communicated within 24 hours. Tier 1 issues may be handled by whichever team member is closest to the situation, without requiring escalation, provided the response timing is met.

Tier 2 — a missed deliverable or a significant quality shortfall: a vendor failing to deliver as briefed, a noticeable service gap during an event, anything that a reasonable client would consider a real failure rather than friction. Tier 2 requires acknowledgment within 2 business hours and must be escalated directly to the Client Relations lead rather than handled informally — the Client Relations lead owns the resolution plan, which must be communicated to the client within 12 hours of the complaint being raised.

Tier 3 — anything affecting the client's own event-day experience directly, or any complaint at all from a high-value retainer client regardless of its apparent severity: this tier is escalated to Studio ownership immediately, with no tier-1 or tier-2 holding period applied first. Same-day response is the minimum standard for Tier 3, and Studio ownership determines both the resolution plan and whether Finance needs to be looped in for a goodwill gesture.

Goodwill gesture authority is tiered by role to keep resolution fast without requiring sign-off for every small gesture. The Client Relations lead may authorize goodwill gestures — partial refunds, complimentary additions to a future booking, fee waivers on a minor line item — up to ₦100,000 in total value per incident without further approval. Anything above ₦100,000 requires both Finance and Studio ownership approval before being offered to the client; this approval should be sought before the offer is communicated, not after, to avoid walking back a commitment already made.

Communication channel preferences stated by a client at intake apply to every subsequent communication, including escalation handling specifically — a client who has stated a WhatsApp preference should be reached via WhatsApp for an escalation, not defaulted back to email because email feels more procedurally formal. High-value retainer clients should additionally have their history and prior preferences actively referenced in escalation communication, not just in routine updates — a client should never feel that an escalation is being handled by someone starting from zero context.

Documentation: every Tier 2 and Tier 3 complaint must be logged in writing regardless of how it was originally raised (phone call, WhatsApp, in person), including the original complaint, the tier assigned, the resolution plan, and the final outcome. This log is reviewed quarterly by Client Relations leadership to identify recurring patterns — a vendor or process appearing in multiple unrelated complaints across a quarter is flagged for a root-cause review independent of any single complaint's resolution.

Post-resolution follow-up is required for every Tier 2 and Tier 3 complaint: a check-in with the client 5–7 business days after resolution, confirming the resolution held and inviting any further feedback. This follow-up is not optional even when the client has not raised further concerns — closing the loop proactively is part of what the tiering system exists to protect.`,
    },
];

async function seedDepartmentPolicies() {
    console.log(`Seeding ${DOCUMENTS.length} department policy documents...`);

    // Re-chunking these from scratch (word-count -> paragraph-based), so
    // clear any existing rows for these exact sources first. Without this,
    // re-running the script duplicates content under the old chunking
    // instead of replacing it.
    const sources = DOCUMENTS.map((d) => d.source);
    const { error: deleteError, count } = await supabase
        .from("kb_documents")
        .delete({ count: "exact" })
        .in("source", sources);

    if (deleteError) {
        console.error("Failed to clear existing rows before re-seeding:", deleteError);
        return;
    }

    console.log(`Cleared ${count ?? 0} existing row(s) for these sources.`);

    for (const doc of DOCUMENTS) {
        const chunks = chunk(doc.content);
        console.log(`  ${doc.source} — ${chunks.length} chunk(s)`);

        for (const [i, content] of chunks.entries()) {
            try {
                const embedding = await embed(content);

                const { error } = await supabase.from("kb_documents").insert({
                    content,
                    source: doc.source,
                    embedding,
                });

                if (error) {
                    console.error(`  ✗ ${doc.source} chunk ${i + 1} failed:`, error.message);
                    continue;
                }

                console.log(`  ✓ ${doc.source} chunk ${i + 1}/${chunks.length} embedded and inserted`);
            } catch (err) {
                console.error(`  ✗ ${doc.source} chunk ${i + 1} embedding failed:`, err);
            }
        }
    }

    console.log("Done.");
}

seedDepartmentPolicies();