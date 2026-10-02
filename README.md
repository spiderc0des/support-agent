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

Design notes, the testing-evidence write-up and the one-pager live in
`docs/`, which is kept out of version control on purpose. Ask the author for
a copy.

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
npm run kb:ingest                 # knowledge base -> kb_chunks (checked against the gold set; --check to measure only)
npm run seed:admin -- you@company.com   # first admin for /review
```

For the review sign-in, paste `supabase/email-templates/*.html` into
Authentication → Emails. Then add `<app>/auth/confirm` (and
`http://localhost:3000/auth/confirm`) to Authentication → URL Configuration.

### 2. Check everything offline first

```bash
npm run check          # typecheck + lint:skills + 92 tests (no keys, no network, no cost)
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
npm run eval                          # 19 scenarios on AGENT_MODEL; results -> eval_runs / evaluations
npm run eval -- --only S5,S7 --repeat 3
npm run eval -- --model claude-sonnet-5
npm run eval -- --voice               # records scenario 9 from the latest real call
```

The eval starts a local MCP server if none is running. Results are at
`/review/evals`.

**Model gate:** the agent runs on `claude-haiku-4-5`. If a scenario fails
repeatedly and prompt fixes don't help, set `AGENT_MODEL=claude-sonnet-5`
and re-run the eval.

## Support console (`/review`)

Invite-only sign-in (a magic link from `/login`). There are two roles:

| | Support agent | Admin |
| --- | --- | --- |
| Overview: open escalations, your tickets, 7-day stats | yes | yes |
| Tickets and escalations: filter, search, assign, start, close with a resolution note, reopen, add notes, confirm a callback time | yes | yes |
| Conversations: transcript, tool calls, knowledge used, events | yes | yes |
| Evaluations | yes | yes |
| Admin: invite people, change roles, remove access, system and configuration status | no | yes |
| Admin: edit the knowledge base and re-ingest it | no | yes |

Every change to a ticket or escalation asks for confirmation first, and is
recorded in `case_events`, which the ticket's Activity panel shows. On the
voice page, starting and ending a call also ask for confirmation.

The first admin is created with `npm run seed:admin -- you@company.com`.
Everyone after that is invited from Admin.

### Editing the knowledge base

Admins edit the approved knowledge base at **Admin → Knowledge base**
(`/review/admin/knowledge`) and re-ingest it without a deploy:

1. Edit the Markdown. Each `##` is a section and each `###` under it is one
   searchable chunk; the outline beside the editor shows the chunks and their
   ids as you type. Search keywords (synonyms per chunk) are under *Advanced*.
2. **Check changes.** The new chunks are loaded into search inside a
   transaction, the 39 gold questions in `data/retrieval-gold.json` run against
   them with the real `match_kb`, and the transaction is rolled back. The
   report lists added, changed and removed chunks, recall@3, and any question
   that would stop finding its answer.
3. **Publish and re-ingest.** The same run, kept. Publishing is refused if any
   gold question that works today would stop working, recall@3 falls below
   90%, or an off-topic question starts matching. An admin can still
   *Publish anyway*, which is marked on the version.

Every publish is a row in `kb_versions` (text, keywords, chunk count, recall,
who, why). The history panel loads any earlier version back into the editor
to restore it. Calls in progress use the new text from their next question;
nothing is cached. `npm run kb:ingest` goes through the same function
(`kb_publish`, migration 0011), so ingests from the repository appear in the
history too, and running it publishes the repository file over console edits.

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
