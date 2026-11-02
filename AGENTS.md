<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Warrant — repo notes

Single Next.js 16 App Router app (React 19, Tailwind 4, npm). `@/*` maps to the repo root. No monorepo.

## Commands
- `npm run dev` / `npm run build` / `npm start`
- `npm run lint` — ESLint only. There is no `typecheck` or `test` script.
- `npx tsc --noEmit` — typecheck.
- Tests are hand-run assertion scripts, no framework: `npx tsx scripts/test-*.ts`. They stub network/Supabase, require no env, and all currently pass. Run the relevant one(s) after changes.
- Scripts that hit real services need `.env.local`:
  - `npx dotenv -e .env.local -- npx tsx scripts/debug-retrieval.ts "query"`
  - `npx dotenv -e .env.local -- npx tsx scripts/calibrate-confidence.ts`
  - `npx dotenv -e .env.local -- npx tsx scripts/seed.ts` (also `seed-employees.ts`, `seed-department-policies.ts`)

## Request flow
- `app/api/chat/route.ts` streams SSE. Event types the client depends on: `status`, `plan_step`, `kb_context`, `tool_error`, `pending_approval`, `token`, `trace_batch`, `memory_compressed`, `done`, `error`.
- Planner: `lib/agent/planner.ts` (Groq `openai/gpt-oss-120b`; README's "Llama 3.3 70B" is stale). Executor: `lib/agent/executor.ts`. Memory: `lib/agent/memory.ts`. Every stage appends to Supabase `trace_logs`; trace writes never throw.
- `MAX_TOOL_STEPS = 4` in the chat route bounds chained calls per turn.
- Browser sends the full conversation each turn. Server compression is incremental via `conversation_summaries`; do not re-summarize the whole history.

## Tool changes
- `lib/tools/index.ts` `TOOL_REGISTRY` is the source of truth for description, JSON schema, and permission tier.
- Adding a tool requires: `ToolName` in `types/index.ts`, an entry in `TOOL_REGISTRY`, an implementation in `TOOL_IMPLEMENTATIONS` (`lib/agent/executor.ts`), and — if `needs-approval` — an entry in `APPROVAL_EXECUTORS` (`app/api/actions/[id]/route.ts`).
- `needs-approval` tools never execute in the chat loop; they create a `pending_actions` row and execute only after approval in `app/api/actions/[id]/route.ts`. `sendEmail`/`sendBroadcast` are the only ones today; retries live in `app/api/actions/[id]/retry/route.ts` and draft editing in the PATCH handler.
- Keep optional tool params nullable (`type: ["string", "null"]`); gpt-oss emits explicit `null` and Groq rejects schemas that don't allow it. `scripts/test-tool-schemas.ts` audits this.

## Error handling
- All failures go through `lib/agent/classifier.ts` and `types/errors.ts` (`misunderstood`, `tool_failure`, `partial_success`). The UI renders `errorInfo`, not raw errors. New tool/route failure paths should be classified there.
- `retryable` and the client Retry button are gated on "no side-effecting tool already ran"; side effects = anything not `auto` tier.

## Retrieval
- Hybrid search = pgvector + full-text fused with RRF in `lib/tools/searchKnowledgeBase.ts`.
- Confidence thresholds (`MIN_VECTOR_TOP_SCORE`, `DOUBTFUL_VECTOR_TOP_SCORE`, `DUAL_LEG_VECTOR_RATIO`) are measured, not arbitrary. Re-run `scripts/calibrate-confidence.ts` before changing them; `scripts/test-kb-calibration.ts` guards the current evidence.
- `voyage-3-lite` embeddings are 512-dimensional; SQL functions expect `vector(512)`.

## Database / env
- Supabase client is server-only with `SUPABASE_SERVICE_ROLE_KEY` and bypasses RLS. Never import `lib/supabase.ts` into a client component.
- The schema is not fully in this repo. Only two search migrations are tracked in `supabase/migrations/`; they are applied manually in the Supabase SQL editor (no Supabase CLI config or migration runner).
- Env lives in `.env.local` (gitignored): `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VOYAGE_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (falls back to `onboarding@resend.dev`), `EMAIL_SANDBOX_MODE`, plus `RESEND_DEV_EMAIL` when sandbox is on. `AUTH_PASSWORD` and `AUTH_SECRET` are required by middleware.
- `middleware.ts` gates every non-public path on a `warrant_session` cookie derived from `AUTH_PASSWORD` + `AUTH_SECRET`; both are required or auth throws. Public: `/login`, `/api/auth`.
- `EMAIL_SANDBOX_MODE` is read per send; when `true`, all mail is rerouted to `RESEND_DEV_EMAIL` with a `[SANDBOX → ...]` subject.

## Cautions
- README is partly stale: auth now exists, the planner model is gpt-oss-120b, and the 1024-dimension claim is wrong. Trust code/config over README.
- Next 16 route handlers with dynamic params use `params: Promise<{ id: string }>` — await it.

## Working rules (read first)
- Do ONE task at a time from `PLAN.md`. Stop after each and summarize what changed. Do not start the next task unprompted.
- Before editing, state which files you'll change and why. Keep diffs minimal; no drive-by refactors or renames.
- Definition of done for every task: `npx tsc --noEmit` clean, `npm run lint` clean, and the relevant `scripts/test-*.ts` passing. Report the actual output, never claim a pass you didn't run.
- Do not commit, push, or run git commands that rewrite history. I commit manually.
- Do not install or upgrade dependencies without asking.
- Never read, print, or edit `.env*` files.
- Do not invent database tables or columns. The schema is not fully in the repo; if a task needs schema you can't see, stop and ask.
- Do not change auth (`middleware.ts`), `lib/supabase.ts` exposure rules, or retrieval confidence thresholds unless the task says so.
- If the Next.js docs conflict with what you remember, the docs in `node_modules/next/dist/docs/` win. Read only the guide relevant to the task, not the whole folder.
- If a task is ambiguous, ask instead of guessing.