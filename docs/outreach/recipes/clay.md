# Clay recipes

Clay is where most teams build and enrich lists, so these recipes push Clay rows into the platform and bring found emails back. They use Clay's **HTTP API** enrichment column (to call the API) and a **Webhook** source (to receive events).

Before you start:

1. Create an API key in **Settings → API** with the `member` role. If the table is for one client, limit the key to that client.
2. In Clay, add the key once: **HTTP API → Add account → Header**: `Authorization` = `Bearer ok_live_…`. Pick this account in every column below.
3. Value used below:

```
BASE = https://<project>.supabase.co/functions/v1/outreach-api/v1
```

Every **HTTP API** column also needs the header `Content-Type: application/json`. Switch on **Remove empty/null values from body** so blank cells are left out. Left-out fields are never blanked on an existing lead.

Clay re-runs columns when you click **Run** again or when auto-update is on. Add the `Idempotency-Key` header on writes so a re-run returns the first answer instead of doing the action twice.

---

## 1. New interested reply → Clay table → Slack or CRM

**Source: Import data from Webhook.** Clay gives the table a URL (`https://api.clay.com/v3/sources/webhook/…`).

Register it once (manager key, or in **Settings → Webhooks**):

```bash
curl -X POST "$BASE/webhooks" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-XXXX","events":["message.classified"]}'
```

Each classified reply becomes a row with `event`, `at` and `data` (`lead_id`, `chat_id`, `intent`, `confidence`, `summary`).

**Column "Lead": HTTP API**

| Field | Value |
|---|---|
| Method | GET |
| Endpoint | `BASE/leads/{{data.lead_id}}` |
| Only run if | `{{data.intent}}` equals `interested` |

**Column "Notify": Slack → Send message** (same run condition)

```
Interested: {{Lead.data.full_name}} ({{Lead.data.title}}, {{Lead.data.company}})
"{{data.summary}}"
https://app.capitalxai.com/outreach/inbox/{{data.chat_id}}
```

Or use Clay's **HubSpot → Create/Update contact** with `{{Lead.data.email_work}}`.

---

## 2. Clay row → create lead → enrol (preview, then commit)

Your table has at least `LinkedIn URL`, `First Name`, `Last Name`, `Company`, `Title`, and maybe `Work Email`.

**Column "Outreach lead": HTTP API**

| Field | Value |
|---|---|
| Method | POST |
| Endpoint | `BASE/leads` |
| Headers | `Idempotency-Key`: `clay-lead-{{Row ID}}` |
| Body | see below |

```json
{
  "linkedin_url": "{{LinkedIn URL}}",
  "first_name": "{{First Name}}",
  "last_name": "{{Last Name}}",
  "company": "{{Company}}",
  "title": "{{Title}}",
  "email": "{{Work Email}}",
  "custom": { "clay_table": "Q4 SaaS founders", "icebreaker": "{{Icebreaker}}" },
  "source": "clay"
}
```

The response holds `data.id` (the lead id) and `created` (true for a new lead). Running the column again on the same person updates the lead. It does not create a copy. Values in `custom` are available in sequences as `{{custom.icebreaker}}`.

**Column "Enrol preview": HTTP API**

| Field | Value |
|---|---|
| Method | POST |
| Endpoint | `BASE/enrollments/preview` |
| Body | `{"sequence_id":"YOUR_SEQUENCE_ID","lead_ids":["{{Outreach lead.data.id}}"]}` |
| Only run if | `{{Outreach lead.data.id}}` is not empty, and your own approval column (for example `Approved` = true) |

Look at `data.eligible` and `data.excluded` before going on. The preview changes nothing.

**Column "Enrol": HTTP API**

| Field | Value |
|---|---|
| Method | POST |
| Endpoint | `BASE/enrollments` |
| Headers | `Idempotency-Key`: `clay-enrol-{{Row ID}}` |
| Body | `{"sequence_id":"YOUR_SEQUENCE_ID","lead_ids":["{{Outreach lead.data.id}}"],"confirm":true}` |
| Only run if | `{{Enrol preview.data.eligible}}` equals `1` |

The commit is limited to 60 calls per hour per key. For tables over a few hundred rows, do not enrol row by row. Instead set a list in the first column (`"list_id": "YOUR_LIST_ID"` in the body, list ids come from `GET BASE/me`) and enrol the whole list from the app, or collect ids and send them in one call (`lead_ids` takes up to 10,000).

---

## 3. Find email in Clay → `PATCH /leads/{id}`

This is how to fill work emails until the find-email step is configured in your workspace. The platform does not resell data, so the lookup happens in Clay with your own providers.

**Get the leads into Clay.** Either you started in Clay (recipe 2, you already have `Outreach lead.data.id`), or pull a list from the API and keep the rows where `email_work` is empty:

```bash
curl "$BASE/leads?list_id=YOUR_LIST_ID&limit=200&offset=0" -H "Authorization: Bearer $KEY"
```

Import the result as CSV or JSON. Keep `id`, `public_identifier`, `full_name`, `company`.

**Column "Work email": Clay's Find Work Email waterfall** with your providers, plus a verifier. Output: `Work Email`.

**Column "Save email": HTTP API**

| Field | Value |
|---|---|
| Method | PATCH |
| Endpoint | `BASE/leads/{{id}}` |
| Headers | `Idempotency-Key`: `clay-email-{{id}}` |
| Body | `{"email_work":"{{Work Email}}"}` |
| Only run if | `{{Work Email}}` is not empty |

What happens:

- Only `email_work` changes. Name, company, stage, tags, list and custom fields are not touched. A field you leave out is never blanked.
- If the lead already has a work email, it is kept. The response then has `"unchanged_fields": ["email_work"]`, so you can see it in Clay.
- Email steps in a sequence can use the address from the next planning cycle on.

No lead id in the table? Use `POST BASE/leads` with `{"linkedin_url":"{{LinkedIn URL}}","email_work":"{{Work Email}}"}`. It finds the lead by its LinkedIn id.

---

## 4. Meeting booked → CRM deal

**Source: Import data from Webhook**, registered for `meeting.booked`:

```bash
curl -X POST "$BASE/webhooks" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-YYYY","events":["meeting.booked"]}'
```

Row fields: `data.lead_id`, `data.sender_id`, `data.provider`, `data.starts_at`, `data.booking_id`.

**Column "Lead": HTTP API** — GET `BASE/leads/{{data.lead_id}}`

**Column "Contact": HubSpot → Create/Update contact** — Email `{{Lead.data.email_work}}`, names, company, job title.

**Column "Deal": HubSpot → Create deal** (or Pipedrive / Salesforce)

| Field | Value |
|---|---|
| Deal name | `{{Lead.data.company}} – {{Lead.data.full_name}}` |
| Stage | Appointment scheduled |
| Close date | `{{data.starts_at}}` |
| Associate with | the contact above |

**Column "Stage" (optional): HTTP API** — PUT `BASE/leads/{{data.lead_id}}/stage` with body `{"stage_id":"YOUR_MEETING_STAGE_ID"}`.
