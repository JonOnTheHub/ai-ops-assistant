# Warrant

An AI operations assistant that doesn't act without earning the right to.

Most "AI agent" demos let the model freestyle — call any tool, chain any action, and execute without guardrails. Warrant is the opposite bet: a constrained, deterministic agent where every tool sits behind a permission tier, every decision leaves a trace, and anything that leaves the system (like sending an email to a real customer) waits for human approval — and that approval reports back honestly, not optimistically.

**Live:** https://usewarrant.vercel.app

---

# The Problem

Businesses want to delegate real operational work to AI, but they can't if doing so means losing visibility into what the system did or control over what it's allowed to do unsupervised.

Warrant is built around a simple principle:

> The model proposes. The permission layer decides whether the action is allowed. Every step is logged whether it executes or not — and the system tells the truth about whether an approved action actually succeeded.

Instead of trusting the model, Warrant trusts explicit permissions and verified outcomes.

---

# Architecture

```text
User Message
      │
      ▼
Planner (Groq • Tool Calling)
      │
      ▼
Permission Layer
      ├── auto
      │      └── Execute immediately
      │
      ├── log-and-run
      │      └── Execute + flag in trace
      │
      └── needs-approval
             └── Halt and enter approval queue
      │
      ▼
Tool Execution
      │
      ▼
Result Validator
(rejects malformed tool output)
      │
      ▼
Memory Update
(short-term summary + long-term facts)
      │
      ▼
Streamed Response (SSE)
      │
      ▼
Trace Batch → Live Trace Viewer
```

Every stage writes to an append-only trace log correlated by a `trace_id` for that user turn. Once a turn completes, the full trace is fetched and streamed to a live side panel in the UI — so the audit trail isn't just a database table, it's something you can actually watch happen in real time as you chat.

Each trace records:

- Prompt
- Planning decision
- Permission check
- Tool execution
- Tool result
- Latency
- Final streamed response

Everything is queryable after the fact, and now visible live without leaving the app.

---

# Features

- 🔎 **RAG knowledge search**
  — pgvector similarity search over internal documentation

- 👤 **CRM lookups**
  — Customers, leads, tasks

- ✅ **Task & lead creation**
  — Includes duplicate-lead protection

- ✉️ **Email drafting & sending**
  — Drafting is allowed. Sending always requires human approval, and the outcome shown is _verified_, not assumed — a failed send (e.g. Resend rejecting an unverified recipient) surfaces the real error and stays on screen until dismissed, rather than reporting false success

- 🧠 **Hybrid memory**
  — Conversation summarization (short-term) + long-term embedded memory retrieval

- ⚡ **Real streaming**
  — Server-Sent Events, token-by-token responses, not simulated

- 📜 **Execution tracing**
  — Planner decisions, permission checks, tool calls, validation, latency, final response

- 🖥️ **Live trace viewer**
  — A slide-over panel that renders the full decision chain for each turn as it completes — every plan, permission check, tool call, and response, expandable to raw input/output payloads, color-coded by outcome

---

# Permission Model

| Tier             | Behavior                                         | Example Tools                        |
| ---------------- | ------------------------------------------------ | ------------------------------------ |
| `auto`           | Executes immediately                             | `searchKnowledgeBase`, `getCustomer` |
| `log-and-run`    | Executes immediately and is flagged in the trace | `createTask`, `createLead`           |
| `needs-approval` | Stops execution until approved                   | `sendEmail`                          |

Read-only tools execute automatically. Internal mutations (like creating CRM records) execute immediately but are highlighted in the audit trail. External actions that affect real users never execute automatically — and once approved, the system verifies the tool actually succeeded before reporting success back to the person who approved it.

---

# Design Language

Black and wasp yellow, brutalist geometry, utilitarian restraint — sharp corners, thick functional borders, monospace uppercase labels, no soft shadows or gradients. The one deliberate visual flourish — a diagonal black/yellow hazard stripe — appears in exactly two places: the approval card and any trace step marked `pending_approval`. Nowhere else. The stripe isn't decoration; it's the visual expression of the one place in the system where crossing a line has a real cost.

---

# Tech Stack

### Frontend

- Next.js 16, React 19, Tailwind CSS, Framer Motion, Phosphor Icons

### AI

- Groq — Llama 3.3 70B, tool calling, streaming

### Embeddings

- Voyage AI — `voyage-3-lite`, 1024 dimensions

### Database

- Supabase, PostgreSQL, pgvector

### Email

- Resend

---

# Database Schema

Eight core tables: `customers`, `leads`, `tasks`, `kb_documents`, `long_term_memory`, `conversation_summaries`, `pending_actions`, `trace_logs`.

Similarity search is powered by two pgvector functions — knowledge base retrieval and long-term memory retrieval.

---

# Known Limitations (documented, not hidden)

- **No `updateLead` or `getLeads` tool.** Out of scope for the assigned 5-tool spec. During testing this surfaced a real hallucination case — the model claimed a lead update succeeded when no tool existed to perform it. Fixed with an explicit system-prompt honesty constraint requiring the agent to disclose capability gaps rather than simulate success. The underlying tool gap was left unresolved by design.
- **No authentication.** Anyone with the URL can currently approve pending actions, including sending real emails. Flagged plainly rather than silently omitted — this is the clearest next step before any real deployment.

---

# Why "Warrant"

A warrant is permission that has to be earned before an action proceeds. That is exactly how Warrant behaves. The model never decides what it is allowed to do — it proposes, the permission layer decides, and the system reports back honestly about what actually happened.

---

Built as **Project #3** in an AI systems curriculum focused on tool calling, observability, constrained agents, human approval workflows, and production-oriented AI system design.
