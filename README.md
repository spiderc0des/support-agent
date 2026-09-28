# RelayPay Support Agent

A production-style voice support agent for RelayPay. A caller speaks to it in
the browser or on the phone. It answers from approved knowledge, looks up
accounts, transactions and payouts, opens tickets, escalates to a human, and
logs every step to Supabase.

```
caller ──voice──▶ Vapi (speech ⇄ text) ──Custom LLM──▶ apps/web  /api/vapi/chat/completions
                                                         │  one Claude Agent SDK session per call
                                                         │  (Haiku 4.5, six preloaded skills)
                                                         ▼
                                                 apps/mcp-server  POST /mcp  (7 tools)
                                                         │
                                                         ▼
                                                     Supabase  seed data · knowledge base · logs
```

- **Vapi** does speech only. It runs no model of its own: every turn is sent to our backend.
- **Claude Agent SDK** decides each turn, using a long-lived session per call. It answers, clarifies, escalates or declines.
- **MCP server** (built here): `search_knowledge_base`, `lookup_customer`, `lookup_transaction`, `lookup_payout`, `create_support_ticket`, `create_escalation`, `log_conversation_event`.
- **Supabase** holds the seed customers, transactions and payouts, the 37 knowledge-base chunks, and every runtime record.

The design, and the contradictions it resolves in the brief, are in
[docs/PLAN.md](docs/PLAN.md).

## Layout

```
apps/web/                 Next.js: voice page, Vapi endpoints, /review dashboard, the agent
  .claude/skills/         the six skills (source of truth, preloaded into the prompt)
  src/agent/              session, turn runner, speech filter, system prompt, logging
apps/mcp-server/          the MCP server (HTTP + stdio)
packages/shared/          enums every component agrees on, KB chunker, Supabase client
supabase/migrations/      schema, SQL functions, RLS
data/                     seed CSVs, knowledge base, keywords, retrieval gold set, eval scenarios
scripts/                  migrate, seed, ingest, eval, lint, vapi sync, admin
tests/                    offline tests (PGlite: real SQL, no Supabase needed)
```

## Setup

```bash
npm install
cp .env.example .env.local        # fill it in; comments explain each value
```

### 1. Supabase

Create a project, then:

```bash
npm run db:migrate                # needs SUPABASE_DB_URL and psql; or paste supabase/migrations/*.sql in order
npm run db:seed                   # customers, transactions, payouts
npm run kb:ingest                 # knowledge base -> kb_chunks
npm run seed:admin -- you@company.com   # access to /review
```

For the review sign-in, paste `supabase/email-templates/*.html` into
Authentication → Emails. Then add `<app>/auth/confirm` (and
`http://localhost:3000/auth/confirm`) to Authentication → URL Configuration.

### 2. Check everything offline first

```bash
npm run check          # typecheck + lint:skills + 50 tests (no keys, no network, no cost)
npm run prompt:size    # cached prefix must stay above Haiku's 4,096-token cache minimum
```

### 3. Run locally

```bash
npm run mcp:dev        # terminal 1: MCP server on :8788
npm run web:dev        # terminal 2: web app on :3000
ngrok http 3000        # terminal 3: Vapi needs a public https URL; put it in APP_URL
npm run vapi:sync      # creates the Vapi assistant; copy the printed IDs into .env.local
```

Open http://localhost:3000 and press **Start call**.

Without Vapi, talk to the same pipeline by text:

```bash
curl -s localhost:3000/api/chat -H "authorization: Bearer $DEV_API_TOKEN" \
  -H 'content-type: application/json' -d '{"message":"What fees does RelayPay charge for international payments?"}'
```

### 4. Evaluate

```bash
npm run eval                          # 17 scenarios on AGENT_MODEL; results -> eval_runs / evaluations
npm run eval -- --only S5,S7 --repeat 3
npm run eval -- --model claude-sonnet-5
npm run eval -- --voice               # records scenario 9 from the latest real call
```

The eval starts a local MCP server if none is running. Results are at
`/review/evals`, and [docs/testing-evidence.md](docs/testing-evidence.md) has
the SQL for each evidence row.

**Model gate:** the agent runs on `claude-haiku-4-5`. If a scenario fails
repeatedly and prompt fixes don't help, set `AGENT_MODEL=claude-sonnet-5`
and re-run the eval.

## Deploy (Railway)

Two services from this repository:

| Service | `RAILWAY_DOCKERFILE_PATH` | Notes |
| --- | --- | --- |
| web | `Dockerfile.web` | **1 replica** (live call sessions are in memory), 1 GB+ memory, health check `/api/health` |
| mcp | `Dockerfile.mcp` | stateless; health check `/health` |

1. Set every variable from `.env.example` on both services. The web service
   needs the `NEXT_PUBLIC_*` values at build time; Railway passes them as
   build arguments.
2. Point the web service at the MCP service over private networking:
   `MCP_URL=http://<mcp-service>.railway.internal:<PORT>/mcp`. Use the same
   `MCP_AUTH_TOKEN` on both.
3. Generate a domain for web, set `APP_URL` and `NEXT_PUBLIC_APP_URL` to it,
   and redeploy.
4. `npm run vapi:sync` against the production `APP_URL`.
5. Phone: Vapi dashboard → Phone Numbers → create a number → assign the
   "RelayPay Support" assistant. Put it in `NEXT_PUBLIC_SUPPORT_PHONE` to show
   it on the page. Phone calls are logged with `channel = phone`, and the
   caller's number is masked to its last four digits.
6. Optionally give the MCP service a public domain too, so the deployed
   endpoint can be submitted and tested with MCP Inspector:
   `npx @modelcontextprotocol/inspector`, then Streamable HTTP, `https://<mcp>/mcp`,
   header `Authorization: Bearer <MCP_AUTH_TOKEN>` and `X-Conversation-Id: <a conversation uuid>`.

Locally, Inspector can also run the stdio server:
`npx @modelcontextprotocol/inspector npm run stdio -w @relaypay/mcp-server`.

## What keeps it safe (enforced in code, not only in prompts)

- The agent's only tools are the MCP server's. Built-in tools are removed, and a
  deny-by-default gate logs anything else it reaches for.
- Lookups return a customer-safe `safe_summary` plus routing hints. Contact
  names, emails, recipient names and internal notes are never returned to the
  model.
- Only a verified caller can attach an account to a call. After that,
  another account's references are refused without confirming they exist.
- The conversation each record belongs to comes from the connection header,
  not from the model.
- Creates are idempotent: one open ticket or escalation per issue per call,
  so a barge-in retry can't duplicate it.
- A speech filter removes the control tag, emails the caller didn't say,
  customer IDs and markdown before anything is spoken.
- RLS is on for every table. Only admins can read, and nothing can write
  except the service role on the server.
- Cost is bounded by a per-call model budget, a tool-call cap per turn, a
  per-turn timeout and an idle-session sweep.

## Cost

With Haiku 4.5 and a cached prefix of about 6k tokens, an 8-turn call costs
roughly $0.05–0.08 in model spend. Vapi's per-minute STT/TTS charge is the
larger cost. Each turn's cost and cache reads are stored in
`conversation_turns`.
