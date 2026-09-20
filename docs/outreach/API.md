# Outreach API (v1)

A REST API for agencies and developers who want to move leads in, get replies out, and read the same numbers the app shows.

- Reference: [`openapi.json`](./openapi.json) (OpenAPI 3.1, every route and schema). Import it into Postman, Insomnia or Swagger UI.
- Recipes: [Zapier](./recipes/zapier.md), [Make](./recipes/make.md), [n8n](./recipes/n8n.md), [Clay](./recipes/clay.md).

```
Base URL   https://<project>.supabase.co/functions/v1/outreach-api/v1
Auth       Authorization: Bearer ok_live_…
Format     JSON in, JSON out. UTF-8. Timestamps are ISO 8601 in UTC. Report dates are YYYY-MM-DD in the workspace timezone.
```

## How it works

Every API call runs the same database function the web app runs for that action. The API adds nothing on top and skips nothing:

- Daily caps, sending schedules, warm-up, sender health, reply-stop and suppression lists are enforced in the database. The API cannot send more than the app can, and there is no flag to turn a cap off.
- Numbers in `/reports/*` are the numbers on the Reports screen. They come from the same functions.
- Nothing is deleted through the API. Suppressing a lead or exiting an enrollment keeps the lead, its timeline and its chats.

## Authentication and what a key can do

Create keys in **Settings → API**. A key is shown once. We store only its hash, so a lost key cannot be recovered; revoke it and create a new one. A workspace can have 25 active keys.

```bash
curl https://<project>.supabase.co/functions/v1/outreach-api/v1/me \
  -H "Authorization: Bearer ok_live_3f9c…"
```

`X-API-Key: ok_live_…` works too, for tools that cannot set an `Authorization` header.

A key has three properties:

| Property | Meaning |
|---|---|
| **Workspace** | A key belongs to one workspace. The workspace never appears in a URL. |
| **Role** | `manager`, `member` or `client_viewer`. A key can never have more rights than the person who created it, and never the `owner` role. |
| **Client scope** | Optional list of clients. A scoped key sees and changes only leads, sequences, senders and threads of those clients. An empty list means every client the creator can see. |

A key **acts as the member who created it**. Audit log entries show that member. If that member is removed from the workspace, or their role is lowered, the key loses the same rights at once. A key can also have an expiry date.

What each role can call:

| Role | Can |
|---|---|
| `client_viewer` | Every `GET` except webhooks. Read only. |
| `member` | The above, plus create and update leads, tags, stage, list, suppress a lead, enrich, preview and commit enrollments, pause / resume / exit / recover, set intent, assign threads, complete tasks. |
| `manager` | The above, plus activate and pause sequences, blacklists (`POST /suppressions`), and webhooks. |

`GET /v1/me` returns the key's role and scope, plus the ids you need elsewhere: clients, stages, tags and lists.

## Responses

A single resource or a plain list:

```json
{ "data": { "id": "…" } }
```

A paginated list:

```json
{ "data": [ … ], "total": 1240, "limit": 50, "offset": 0, "has_more": true }
```

Every response carries `X-Request-Id`. Quote it when you ask for help.

## Pagination

`limit` (1 to 200, default 50) and `offset` (default 0) on `GET /leads`, `/enrollments`, `/threads` and `/sequences/{id}/failed`. Read until `has_more` is `false`. To poll for changes, use `GET /leads?updated_since=2026-09-20T00:00:00Z` or `GET /threads?since=…` instead of walking every page.

## Errors

```json
{ "error": { "code": "E_FORBIDDEN", "message": "member required", "request_id": "req_7d4adb847ff54f2ebf0166fc" } }
```

`code` is stable and safe to branch on. `message` is a plain sentence you can show to a person.

| HTTP | Code | What to do |
|---|---|---|
| 400 | `E_CONFIRM_REQUIRED` | Commit without `confirm: true`. Preview first. |
| 400 | `E_POOL_EMPTY`, `E_SENDER_NOT_OK`, `E_SENDER_NOT_IN_POOL`, `E_INFLIGHT`, other `E_…` | A rule in the database said no. The message says which. |
| 401 | `E_UNAUTHORIZED` | Key missing, wrong, revoked or expired. |
| 402 | `E_PLAN_SUSPENDED` | The workspace is suspended. Fix billing in the app. |
| 403 | `E_FORBIDDEN` | The key's role or client scope does not allow this. |
| 404 | `E_NOT_FOUND` | No such record, or it belongs to a client outside the key's scope. |
| 409 | `E_IDEMPOTENCY_MISMATCH` | The `Idempotency-Key` was used before with a different request. |
| 409 | `E_IN_PROGRESS` | The first request with this `Idempotency-Key` is still running. Retry in a few seconds. |
| 409 | `E_CONFLICT` | The identifiers you sent belong to another lead. |
| 422 | `E_PAYLOAD_INVALID`, `E_TOO_MANY`, `E_GRAPH_INVALID` | Fix the request. The message names the field. Unknown fields are rejected, not ignored. |
| 429 | `E_RATE_LIMITED` | Wait for `Retry-After` seconds. |
| 500 | `E_INTERNAL` | Our fault. Nothing was changed. Retry with the same `Idempotency-Key`. |

## Rate limits

Per key, per hour:

| Class | Limit | Which calls |
|---|---|---|
| read | 600 | Every `GET`, and `POST /enrollments/preview` (it changes nothing). |
| write | 300 | Every `POST`, `PUT`, `PATCH`, `DELETE`. |
| spend | 60 | Calls that start spending a sender's budget: `POST /enrollments`, `POST /enrollments/recover`, `POST /leads/enrich`, `POST /sequences/{id}/activate`, `POST /threads/{id}/reply`. These also count as a write. |

Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds) for the tightest class that applies to the call. A 429 carries `Retry-After`.

These limits protect the API. They are not the sending limits. How many invites or messages a sender makes per day is decided by the caps in the app, and no number of API calls changes that. For bulk work, send many ids in one call (`lead_ids` takes up to 10,000 on enrollments, 5,000 on enrich) instead of one call per lead.

## Idempotency

Send an `Idempotency-Key` header (any string up to 255 characters, a UUID is fine) on any `POST`, `PUT`, `PATCH` or `DELETE`:

- Same key, same request: you get the first answer again, with the header `Idempotent-Replayed: true`. Nothing runs twice.
- Same key, different method, path or body: `409 E_IDEMPOTENCY_MISMATCH`.
- Same key while the first request is still running: `409 E_IN_PROGRESS`.
- Answers with status below 500 are stored, including 4xx. A 5xx is not stored, because a failed call changes nothing, so you can retry with the same key.

Keys are kept per API key. Use a new key for each new action, for example the row id from your sheet plus the step name.

Zapier, Make and n8n retry on timeouts. Set the header on every write in a recipe.

## Partial updates

`POST /v1/leads` (create or update) and `PATCH /v1/leads/{id}` change only the fields you send.

- **A field you leave out is never blanked.**
- An empty string or `null` counts as left out. You cannot blank a field through the API.
- `custom` is merged key by key. `{"custom": {"seats": 12}}` keeps every other custom field.
- `email_work`, `email_personal`, `public_identifier` and `client_id` are **filled only when empty**. They are never overwritten. When you send one of these and the lead already has a different value, the call succeeds, the old value stays, and the field name appears in `unchanged_fields`.
- Unknown fields are rejected with 422, so a typo cannot be silently dropped. `phone` is read only for now.

`POST /v1/leads` finds an existing lead by LinkedIn id (`linkedin_url` or `public_identifier`), then `provider_id`, then `email_work`, then `email_personal`. No match creates a lead (`201`, `"created": true`). A match updates it (`200`, `"created": false`).

`PUT /leads/{id}/stage` and `PUT /leads/{id}/list` accept `null` to clear the value.

## Preview, then commit

Enrolling leads is the call that leads to LinkedIn actions, so it takes two steps, the same as in the app.

1. `POST /v1/enrollments/preview` with `sequence_id` and `lead_ids`. It changes nothing. It returns `eligible_ids`, who is excluded and why (`suppressed:…`, `replied_recently`, `already_enrolled`, `no_fresh_sender`), which sender each lead would get, warnings, and how many days the sequence would take.
2. `POST /v1/enrollments` with the same `sequence_id`, the `lead_ids` you want (normally the preview's `eligible_ids`) and `"confirm": true`.

What this does and does not guarantee:

- There is no preview token. The API does not store your preview.
- The commit runs the same plan in the database again and re-checks every rule at that moment. If a lead replied or was suppressed between your preview and your commit, it is skipped. The commit can enrol **fewer** leads than the preview showed, never a lead the rules exclude, and never a lead you did not list.
- The answer tells you what happened: `enrolled`, `skipped_active`, `skipped_suppressed`, `skipped_replied`, `skipped_other`, `waiting`.
- Enrolling does not send anything by itself. Leads start moving when the sequence is active, inside each sender's schedule and caps.

## Webhooks

Create one with `POST /v1/webhooks` (manager key) or in **Settings → Webhooks**. The `secret` is returned once.

We `POST` JSON to your URL:

```json
{
  "event": "message.classified",
  "workspace_id": "12cb6a25-…",
  "at": "2026-09-20T09:14:03.120Z",
  "data": { "id": "…", "chat_id": "…", "lead_id": "…", "intent": "interested", "confidence": 0.93, "summary": "Wants a call next week" }
}
```

Headers: `x-event`, `x-delivery-id`, and `x-signature` (hex HMAC-SHA256 of the raw body, keyed with the webhook secret).

Answer with a 2xx within 10 seconds. Anything else is retried, up to 5 attempts with growing delays (2, 4, 8, 16 minutes). A webhook that fails 50 times in a row is switched off. Deliveries can arrive more than once and out of order, so use `x-delivery-id` to drop duplicates.

### Events

Subscribe to a list of events, or `["*"]` for everything.

| Group | Events |
|---|---|
| Leads | `lead.created`, `lead.updated`, `lead.unsubscribed` |
| Invites | `invite.sent`, `invite.accepted`, `invite.withdrawn` |
| Messages | `message.sent`, `message.received`, `message.classified` |
| Email | `email.sent`, `email.opened`, `email.clicked`, `email.bounced` |
| Enrollments | `enrollment.started`, `enrollment.exited`, `enrollment.completed`, `enrollment.held`, `enrollment.resumed`, `enrollment.recovered` |
| Tasks and meetings | `task.created`, `task.completed`, `meeting.booked` |
| Sequences | `sequence.activated`, `sequence.paused`, `sequence.published`, `sequence.throttled`, `sequence.stalled`, `sequence.recovered`, `sequence.webhook` |
| Senders | `sender.connected`, `sender.disconnected`, `sender.reconnected`, `sender.paused`, `sender.level_changed`, `sender.running_dry` |
| Workspace | `workspace.billing_recovered` |

`message.classified` fires after a reply has been read and given an intent: `interested`, `question`, `not_now`, `not_interested`, `ooo`, `wrong_person`, `unclear`. It is the event to use for "new interested reply". `meeting.booked` carries `lead_id`, `sender_id`, `provider`, `starts_at` and `booking_id`. `sequence.webhook` is sent by a webhook step inside a sequence.

Event payloads carry ids, not full records. Fetch details with `GET /v1/leads/{id}` or `GET /v1/threads/{id}`.

### Verify the signature

Node:

```js
import crypto from "node:crypto";

// rawBody must be the exact bytes we sent, before any JSON parsing
function verify(rawBody, signatureHeader, secret) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(signatureHeader || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Python:

```python
import hmac, hashlib

def verify(raw_body: bytes, signature_header: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header or "")
```

### Replay a delivery

If your endpoint was down, or you fixed a bug and want the event again:

```bash
curl "$BASE/webhooks/deliveries?limit=20" -H "Authorization: Bearer $KEY"
curl -X POST "$BASE/webhooks/deliveries/48211/replay" -H "Authorization: Bearer $KEY"
```

A replay is a new delivery with the same payload plus `"replayed": true` and `"replay_of": 48211`. It goes out within about 30 seconds and is signed like any other delivery.

## Sending replies

`POST /v1/threads/{id}/reply` sends a reply on the thread's own channel (LinkedIn message or email) through the same code as the inbox. Body: `text`, optional `subject` (email), optional `booking: true` to append the sender's booking link. The key needs the member role or higher, the member who created it must be allowed to reply, and a client-scoped key can only reply on its clients' threads. It counts against the 60 per hour budget-spending limit.

## Ten common calls

```bash
BASE=https://<project>.supabase.co/functions/v1/outreach-api/v1
KEY=ok_live_…
```

**1. Check the key and get ids for clients, stages, tags, lists**

```bash
curl "$BASE/me" -H "Authorization: Bearer $KEY"
```

**2. Create or update a lead**

```bash
curl -X POST "$BASE/leads" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: sheet-row-118" \
  -d '{"linkedin_url":"https://www.linkedin.com/in/jane-doe","first_name":"Jane","last_name":"Doe","company":"Acme","title":"Head of Sales","custom":{"segment":"saas"}}'
```

**3. Change one field of a lead (nothing else is touched)**

```bash
curl -X PATCH "$BASE/leads/7b416835-cdee-46ca-b990-510bbef33604" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"email_work":"jane@acme.com"}'
```

**4. Find a lead by email or LinkedIn id**

```bash
curl "$BASE/leads?email=jane@acme.com" -H "Authorization: Bearer $KEY"
curl "$BASE/leads?public_identifier=jane-doe" -H "Authorization: Bearer $KEY"
```

**5. Preview an enrollment**

```bash
curl -X POST "$BASE/enrollments/preview" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"sequence_id":"5c30ae96-98e4-46a2-9532-288f4fc47f7b","lead_ids":["7b416835-cdee-46ca-b990-510bbef33604"]}'
```

**6. Commit it**

```bash
curl -X POST "$BASE/enrollments" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: enrol-sheet-row-118" \
  -d '{"sequence_id":"5c30ae96-98e4-46a2-9532-288f4fc47f7b","lead_ids":["7b416835-cdee-46ca-b990-510bbef33604"],"confirm":true}'
```

**7. Threads waiting on you, interested first**

```bash
curl "$BASE/threads?waiting_on_us=true&intent=interested&limit=50" -H "Authorization: Bearer $KEY"
curl "$BASE/threads/32b5f80e-d914-476e-9388-5a92e745f019" -H "Authorization: Bearer $KEY"
```

**8. Numbers for a period, for one client**

```bash
curl "$BASE/reports/overview?from=2026-09-01&to=2026-09-30&client_id=…" -H "Authorization: Bearer $KEY"
curl "$BASE/reports/funnel?from=2026-09-01&to=2026-09-30" -H "Authorization: Bearer $KEY"
```

**9. Why is this sequence not sending?**

```bash
curl "$BASE/sequences/5c30ae96-98e4-46a2-9532-288f4fc47f7b/why-not-sending" -H "Authorization: Bearer $KEY"
```

**10. Create a webhook for classified replies and booked meetings**

```bash
curl -X POST "$BASE/webhooks" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://hooks.example.com/outreach","events":["message.classified","meeting.booked"]}'
```

Also useful: stop contacting someone with `POST /leads/{id}/suppress`, blacklist a domain with `POST /suppressions` and `{"rows":[{"value":"competitor.com"}]}`, check a sender with `GET /senders/{id}/capacity`.

## All routes

| Resource | Routes |
|---|---|
| Meta | `GET /me` · `GET /metrics/definitions` |
| Leads | `GET /leads` · `POST /leads` · `GET /leads/{id}` · `PATCH /leads/{id}` · `POST /leads/{id}/tags` · `DELETE /leads/{id}/tags/{tag_id}` · `PUT /leads/{id}/stage` · `PUT /leads/{id}/list` · `POST /leads/{id}/suppress` · `DELETE /leads/{id}/suppress` · `GET /leads/{id}/timeline` · `POST /leads/enrich` · `POST /suppressions` |
| Enrollments | `POST /enrollments/preview` · `POST /enrollments` · `GET /enrollments` · `POST /enrollments/{id}/pause` · `…/resume` · `…/exit` · `POST /enrollments/recover` |
| Sequences | `GET /sequences` · `GET /sequences/{id}` · `GET /sequences/{id}/stats` · `POST /sequences/{id}/activate` · `POST /sequences/{id}/pause` · `GET /sequences/{id}/failed` · `GET /sequences/{id}/why-not-sending` |
| Inbox | `GET /threads` · `GET /threads/{id}` · `POST /threads/{id}/reply` · `PUT /threads/{id}/intent` · `PUT /threads/{id}/assignee` |
| Senders | `GET /senders` · `GET /senders/{id}` · `GET /senders/{id}/health` · `GET /senders/{id}/budgets` · `GET /senders/{id}/capacity` |
| Reports | `GET /reports/overview` · `/funnel` · `/intents` · `/reply-threads` · `/cost` · `/sequences` · `/senders` · `/clients` · `/sequences/{id}` · `/senders/{id}` · `/clients/{id}` |
| Webhooks | `GET /webhooks` · `POST /webhooks` · `DELETE /webhooks/{id}` · `GET /webhooks/deliveries` · `POST /webhooks/deliveries/{id}/replay` |
| Tasks | `POST /tasks/{id}/complete` |

Building and publishing sequences, connecting senders and changing caps are not in the API. Do those in the app or through the Claude connector.

## For maintainers

- Code: `supabase/functions/outreach-api/`. `index.ts` holds auth, rate limits, idempotency and error mapping. `dispatch.ts` holds `call(ctx, fn, args)`, the only way a route reaches the database. `routes_*.ts` hold one resource each.
- Every route ends in `outreach_api_dispatch(key_id, fn, args)`. To add a route, the function must be on the whitelist in `migrations/outreach/015_platform.sql`.
- Deploy with JWT verification off (`--no-verify-jwt`). An API key is not a JWT, and the function checks the key itself on every `/v1` route.
- After changing routes, update `openapi.json` and run `deno run --allow-read supabase/functions/outreach-api/openapi_check.ts`. It fails when a route is missing from the spec or the other way round.
- Reply hand-over: `outreach-send-reply` keeps its send logic inside its request handler and authenticates with `requireUser` (a member JWT). To switch on `POST /threads/{id}/reply`, move that logic into an exported function, for example `sendReply({ userId, role, clientIds, chatId, text, subject, attachments })` in `_shared/outreach/reply.ts`, call it from both functions, and have it check `can_reply` and client visibility against the role and scope passed in (the key's, not the member's).
