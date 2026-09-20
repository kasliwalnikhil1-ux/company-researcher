# n8n recipes

Four workflows you can copy. They use the **Webhook** node (to receive events) and the **HTTP Request** node (to call the API).

Before you start:

1. Create an API key in **Settings → API**. Use the `member` role for workflows 2 to 4. Creating a webhook needs a `manager` key, or do it in **Settings → Webhooks**.
2. In n8n, create one credential and reuse it everywhere: **Credentials → New → Header Auth** with Name `Authorization` and Value `Bearer ok_live_…`.
3. Value used below:

```
BASE = https://<project>.supabase.co/functions/v1/outreach-api/v1
```

Every API call is an **HTTP Request** node with these common settings:

| Field | Value |
|---|---|
| Authentication | Generic Credential Type → Header Auth → the credential above |
| Send Body | On (for POST / PUT / PATCH) |
| Body Content Type | JSON |
| Specify Body | Using JSON |
| Options → Retry On Fail | On, 3 tries, 5000 ms |

With Retry On Fail switched on, always send an `Idempotency-Key` header on writes (**Send Headers** → On). A retry with the same key returns the first answer and runs nothing twice.

---

## 1. New interested reply → Slack (or your CRM)

**Node 1: Webhook**

| Field | Value |
|---|---|
| HTTP Method | POST |
| Path | `outreach-replies` |
| Respond | Immediately |
| Options → Raw Body | On (needed for the signature check) |

Register the **Production URL** once:

```bash
curl -X POST "$BASE/webhooks" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://n8n.example.com/webhook/outreach-replies","events":["message.classified"]}'
```

**Node 2: Code** (verify the signature; skip it if you trust the URL being secret)

```js
const crypto = require('crypto');
const item = $input.first();
const raw = Buffer.from(item.binary.data.data, 'base64').toString('utf8');
const expected = crypto.createHmac('sha256', 'YOUR_WEBHOOK_SECRET').update(raw).digest('hex');
if (expected !== item.json.headers['x-signature']) throw new Error('bad signature');
return [{ json: JSON.parse(raw) }];
```

**Node 3: IF** — `{{ $json.data.intent }}` *is equal to* `interested`.

**Node 4: HTTP Request** — Method GET, URL `BASE/leads/{{ $json.data.lead_id }}`

**Node 5: HTTP Request** — Method GET, URL `BASE/threads/{{ $('IF').item.json.data.chat_id }}?limit=5`

**Node 6: Slack → Send a message**

```
Interested reply from {{ $('HTTP Request').item.json.data.full_name }} ({{ $('HTTP Request').item.json.data.company }})
"{{ $('IF').item.json.data.summary }}"
Last message: {{ $json.data.last_message_preview }}
https://app.capitalxai.com/outreach/inbox/{{ $('IF').item.json.data.chat_id }}
```

For a CRM, replace node 6 with **HubSpot → Contact → Create or Update** and **Engagement → Create**.

Missed events while n8n was down? List them with `GET BASE/webhooks/deliveries` and send any of them again with `POST BASE/webhooks/deliveries/{id}/replay`.

---

## 2. New row in Google Sheets → create lead → enrol

**Node 1: Google Sheets Trigger** — Event: Row Added. Columns: `linkedin_url`, `first_name`, `last_name`, `company`, `title`, `email`.

**Node 2: HTTP Request** (create or update the lead)

| Field | Value |
|---|---|
| Method | POST |
| URL | `BASE/leads` |
| Send Headers | `Idempotency-Key`: `lead-{{ $json.row_number }}` |
| JSON | see below |

```
={{ JSON.stringify(Object.fromEntries(Object.entries({
  linkedin_url: $json.linkedin_url,
  first_name: $json.first_name,
  last_name: $json.last_name,
  company: $json.company,
  title: $json.title,
  email: $json.email,
  source: 'n8n-sheet'
}).filter(([, v]) => v !== '' && v != null))) }}
```

The filter drops empty cells. Empty values never blank a field, but an empty `email` would fail the format check.

**Node 3: Aggregate** — Aggregate: Individual Fields, Input Field Name `data.id`, Rename Field `lead_ids`. This turns many rows into one enrol call.

**Node 4: HTTP Request** (preview)

| Field | Value |
|---|---|
| Method | POST |
| URL | `BASE/enrollments/preview` |
| JSON | `={{ JSON.stringify({ sequence_id: 'YOUR_SEQUENCE_ID', lead_ids: $json.lead_ids }) }}` |

**Node 5: IF** — `{{ $json.data.eligible }}` *is greater than* `0`. On the false branch, log `{{ $json.data.excluded }}`: it says who was left out and why.

**Node 6: HTTP Request** (commit)

| Field | Value |
|---|---|
| Method | POST |
| URL | `BASE/enrollments` |
| Send Headers | `Idempotency-Key`: `enrol-{{ $execution.id }}` |
| JSON | `={{ JSON.stringify({ sequence_id: 'YOUR_SEQUENCE_ID', lead_ids: $json.data.eligible_ids, confirm: true }) }}` |

The commit checks every rule again. A lead that replied after the preview is skipped and counted in `skipped_replied`.

---

## 3. Found an email → fill it on the lead

**Node 1:** the source of the email (a sheet, Hunter, Apollo, a Clay webhook). It must give you `lead_id` or `linkedin_url`, and `work_email`.

**Node 2: HTTP Request**

| Field | Value |
|---|---|
| Method | PATCH |
| URL | `BASE/leads/{{ $json.lead_id }}` |
| Send Headers | `Idempotency-Key`: `email-{{ $json.lead_id }}` |
| JSON | `={{ JSON.stringify({ email_work: $json.work_email }) }}` |

No lead id? Method POST, URL `BASE/leads`, JSON `={{ JSON.stringify({ linkedin_url: $json.linkedin_url, email_work: $json.work_email }) }}`.

Only `email_work` changes. If the lead already has one, it is kept and the response has `"unchanged_fields": ["email_work"]`.

---

## 4. Meeting booked → CRM deal

**Node 1: Webhook** — POST, path `outreach-meetings`. Register it for `meeting.booked`:

```bash
curl -X POST "$BASE/webhooks" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://n8n.example.com/webhook/outreach-meetings","events":["meeting.booked"]}'
```

Fields under `body.data`: `lead_id`, `sender_id`, `provider`, `starts_at`, `booking_id`.

**Node 2: HTTP Request** — GET `BASE/leads/{{ $json.body.data.lead_id }}`

**Node 3: HubSpot → Contact → Create or Update** — Email `{{ $json.data.email_work }}`, plus names, company, job title.

**Node 4: HubSpot → Deal → Create**

| Field | Value |
|---|---|
| Deal Name | `{{ $('HTTP Request').item.json.data.company }} – {{ $('HTTP Request').item.json.data.full_name }}` |
| Deal Stage | appointmentscheduled |
| Close Date | `{{ $('Webhook').item.json.body.data.starts_at }}` |
| Associated Contacts | id from node 3 |

(Pipedrive: **Person → Create**, then **Deal → Create**.)

**Node 5 (optional): HTTP Request** — Method PUT, URL `BASE/leads/{{ $('Webhook').item.json.body.data.lead_id }}/stage`, JSON `{"stage_id":"YOUR_MEETING_STAGE_ID"}`. Stage ids come from `GET BASE/me`.
