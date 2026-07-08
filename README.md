# Warrant

An AI operations assistant that doesn't act without earning the right to.

Most "AI agent" demos let the model freestyle—call any tool, chain any action, and execute actions without guardrails. Warrant is the opposite bet: a constrained, deterministic agent where every tool sits behind a permission tier, every decision leaves a trace, and anything that leaves the system (like sending an email to a real customer) waits for human approval.

**Live:** https://usewarrant.vercel.app

---

# The Problem

Businesses want to delegate real operational work to AI, but they can't if doing so means losing visibility into what the system did or control over what it's allowed to do unsupervised.

Warrant is built around a simple principle:

> The model proposes. The permission layer decides whether the action is allowed. Every step is logged whether it executes or not.

Instead of trusting the model, Warrant trusts explicit permissions.

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
```

Every stage writes to an append-only trace log correlated by a `trace_id` for that user turn.

Each trace records:

- Prompt
- Planning decision
- Permission check
- Tool execution
- Tool result
- Latency
- Final streamed response

Everything is queryable after the fact.

---

# Features

- 🔎 **RAG knowledge search**
  - pgvector similarity search over internal documentation

- 👤 **CRM lookups**
  - Customers
  - Leads
  - Tasks

- ✅ **Task & lead creation**
  - Includes duplicate-lead protection

- ✉️ **Email drafting & sending**
  - Drafting is allowed
  - Sending always requires human approval

- 🧠 **Hybrid memory**
  - Conversation summarization
  - Long-term embedded memory retrieval

- ⚡ **Real streaming**
  - Server-Sent Events (SSE)
  - Token-by-token responses (not simulated)

- 📜 **Execution tracing**
  - Planner decisions
  - Permission checks
  - Tool calls
  - Validation
  - Latency
  - Final response

---

# Permission Model

| Tier             | Behavior                                         | Example Tools                        |
| ---------------- | ------------------------------------------------ | ------------------------------------ |
| `auto`           | Executes immediately                             | `searchKnowledgeBase`, `getCustomer` |
| `log-and-run`    | Executes immediately and is flagged in the trace | `createTask`, `createLead`           |
| `needs-approval` | Stops execution until approved                   | `sendEmail`                          |

Read-only tools execute automatically.

Internal mutations (like creating CRM records) execute immediately but are highlighted in the audit trail.

External actions that affect real users never execute automatically.

---

# Tech Stack

### Frontend

- Next.js 16
- React 19
- Tailwind CSS
- Framer Motion
- Phosphor Icons

### AI

- Groq
  - Llama 3.3 70B
  - Tool Calling
  - Streaming

### Embeddings

- Voyage AI
  - `voyage-3-lite`
  - 1024 dimensions

### Database

- Supabase
- PostgreSQL
- pgvector

### Email

- Resend

---

# Database Schema

Eight core tables:

- `customers`
- `leads`
- `tasks`
- `kb_documents`
- `long_term_memory`
- `conversation_summaries`
- `pending_actions`
- `trace_logs`

Similarity search is powered by two pgvector functions:

- Knowledge base retrieval
- Long-term memory retrieval

---

# Why "Warrant"

A warrant is permission that has to be earned before an action proceeds.

That is exactly how Warrant behaves.

The model never decides what it is allowed to do.

It proposes.

The permission layer decides.

---

Built as **Project #3** in an AI systems curriculum focused on:

- tool calling
- observability
- constrained agents
- human approval workflows
- production-oriented AI system design
