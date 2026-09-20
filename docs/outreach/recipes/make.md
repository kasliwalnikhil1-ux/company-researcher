# Make recipes

Four scenarios you can copy. They use two built-in apps: **Webhooks** (to receive events) and **HTTP → Make a request** (to call the API).

Before you start:

1. Create an API key in **Settings → API**. Use the `member` role for scenarios 2 to 4. Creating a webhook needs a `manager` key, or do it in **Settings → Webhooks**.
2. Values used below:

```
BASE = https://<project>.supabase.co/functions/v1/outreach-api/v1
KEY  = ok_live_…
```

Every API call is **HTTP → Make a request** with these common settings:

| Field | Value |
|---|---|
| Headers | `Authorization`: `Bearer KEY` |
| Body type | Raw |
| Content type | JSON (application/json) |
| Parse response | Yes |
| Evaluate all states as errors (except for 2xx and 3xx) | Yes |

Make re-runs incomplete executions. Set the `Idempotency-Key` header on every write so a re-run cannot do the action twice.

---

## 1. New interested reply → Slack (or your CRM)

**Module 1: Webhooks → Custom webhook.** Create a webhook, copy its address (`https://hook.eu2.make.com/…`).

Register it once:

```bash
curl -X POST "$BASE/webhooks" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://hook.eu2.make.com/abc123","events":["message.classified"]}'
```

Click **Redetermine data structure**, then replay an old delivery (`POST $BASE/webhooks/deliveries/{id}/replay`) so Make learns the fields.

**Filter between module 1 and 2:** `data.intent` *Equal to* `interested`.

**Module 2: HTTP → Make a request**

| Field | Value |
|---|---|
| URL | `BASE/leads/{{1.data.lead_id}}` |
| Method | GET |

**Module 3: HTTP → Make a request**

| Field | Value |
|---|---|
| URL | `BASE/threads/{{1.data.chat_id}}?limit=5` |
| Method | GET |

**Module 4: Slack → Create a Message**

```
Interested reply from {{2.data.data.full_name}} ({{2.data.data.title}}, {{2.data.data.company}})
"{{1.data.summary}}"
Last message: {{3.data.data.last_message_preview}}
https://app.capitalxai.com/outreach/inbox/{{1.data.chat_id}}
```

`2.data.data` is not a typo: Make puts the HTTP response under `data`, and the API puts the record under `data`.

To verify the signature, open the webhook's advanced settings, switch on **Get request headers** and **JSON pass-through**, then add **Tools → Set variable** with `{{sha256(1.value; "hex"; YOUR_WEBHOOK_SECRET)}}` and a filter that compares it with the `x-signature` header.

For a CRM, replace module 4 with **HubSpot CRM → Create/Update a Contact** and **Create an Engagement**.

---

## 2. New row in Google Sheets → create lead → enrol

**Module 1: Google Sheets → Watch New Rows.** Columns: `linkedin_url`, `first_name`, `last_name`, `company`, `title`, `email`.

**Module 2: HTTP → Make a request** (create or update the lead)

| Field | Value |
|---|---|
| URL | `BASE/leads` |
| Method | POST |
| Headers | `Authorization`, plus `Idempotency-Key`: `lead-{{1.__ROW_NUMBER__}}` |
| Request content | see below |

```json
{
  "linkedin_url": "{{1.linkedin_url}}",
  "first_name": "{{1.first_name}}",
  "last_name": "{{1.last_name}}",
  "company": "{{1.company}}",
  "title": "{{1.title}}",
  "source": "make-sheet"
}
```

Add `"email": "{{1.email}}"` only when the column is always filled. An empty string fails the email format check. Other empty values are fine and never blank a field on an existing lead.

**Module 3: HTTP → Make a request** (preview)

| Field | Value |
|---|---|
| URL | `BASE/enrollments/preview` |
| Method | POST |
| Request content | `{"sequence_id":"YOUR_SEQUENCE_ID","lead_ids":["{{2.data.data.id}}"]}` |

**Filter:** `3.data.data.eligible` *Greater than* `0`. On the other route, write `{{3.data.data.excluded}}` back to the sheet so you can see why a lead was not enrolled.

**Module 4: HTTP → Make a request** (commit)

| Field | Value |
|---|---|
| URL | `BASE/enrollments` |
| Method | POST |
| Headers | `Authorization`, plus `Idempotency-Key`: `enrol-{{1.__ROW_NUMBER__}}` |
| Request content | `{"sequence_id":"YOUR_SEQUENCE_ID","lead_ids":["{{2.data.data.id}}"],"confirm":true}` |

To enrol a batch in one call, put an **Array aggregator** after module 2 and send `{{map(aggregator.array; "id")}}` as `lead_ids`. One call with 200 ids is better than 200 calls: the commit is in the 60 per hour class.

---

## 3. Found an email → fill it on the lead

**Module 1:** the source of the email (Google Sheets **Watch Changes**, an Apollo or Hunter module, a Clay webhook).

**Module 2: HTTP → Make a request**

| Field | Value |
|---|---|
| URL | `BASE/leads/{{1.lead_id}}` |
| Method | PATCH |
| Headers | `Authorization`, plus `Idempotency-Key`: `email-{{1.lead_id}}` |
| Request content | `{"email_work":"{{1.work_email}}"}` |

No lead id? Use `POST BASE/leads` with `{"linkedin_url":"{{1.linkedin_url}}","email_work":"{{1.work_email}}"}`. It finds the lead by its LinkedIn id.

Only `email_work` changes. If the lead already has a work email, the old one stays and `unchanged_fields` contains `email_work`.

---

## 4. Meeting booked → CRM deal

**Module 1: Webhooks → Custom webhook**, registered for `meeting.booked`:

```bash
curl -X POST "$BASE/webhooks" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://hook.eu2.make.com/def456","events":["meeting.booked"]}'
```

Fields: `data.lead_id`, `data.sender_id`, `data.provider`, `data.starts_at`, `data.booking_id`.

**Module 2: HTTP → Make a request** — `GET BASE/leads/{{1.data.lead_id}}`

**Module 3: HubSpot CRM → Create/Update a Contact** — Email `{{2.data.data.email_work}}`, names, company, job title.

**Module 4: HubSpot CRM → Create a Deal**

| Field | Value |
|---|---|
| Deal name | `{{2.data.data.company}} – {{2.data.data.full_name}}` |
| Deal stage | Appointment scheduled |
| Close date | `{{1.data.starts_at}}` |
| Associated contact | ID from module 3 |

(Pipedrive: **Create a Person** then **Create a Deal**.)

**Module 5 (optional): HTTP → Make a request**

| Field | Value |
|---|---|
| URL | `BASE/leads/{{1.data.lead_id}}/stage` |
| Method | PUT |
| Request content | `{"stage_id":"YOUR_MEETING_STAGE_ID"}` |

Stage ids come from `GET BASE/me`.
