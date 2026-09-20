# Zapier recipes

Four Zaps you can copy. They use **Webhooks by Zapier** (a paid Zapier app) because there is no native Zapier app yet.

Before you start:

1. Create an API key in **Settings → API**. Use the `member` role for recipes 2 to 4. Recipe 1 needs a `manager` key once, to create the webhook (or create the webhook in **Settings → Webhooks** and skip the key).
2. Set these two values wherever a recipe shows them:

```
BASE = https://<project>.supabase.co/functions/v1/outreach-api/v1
KEY  = ok_live_…
```

Every API step below is **Webhooks by Zapier → Custom Request** with these common settings:

| Field | Value |
|---|---|
| Data Pass-Through? | False |
| Unflatten | Yes |
| Headers | `Authorization` = `Bearer KEY` · `Content-Type` = `application/json` |

Zapier retries steps that time out. Always set the `Idempotency-Key` header on writes so a retry cannot run the action twice.

---

## 1. New interested reply → Slack (or your CRM)

**Trigger: Webhooks by Zapier → Catch Hook.** Copy the hook URL Zapier gives you.

Register it once (terminal, manager key):

```bash
curl -X POST "$BASE/webhooks" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://hooks.zapier.com/hooks/catch/123456/abcdef/","events":["message.classified"]}'
```

Send a test reply so Zapier sees a sample, or replay an old delivery: `POST $BASE/webhooks/deliveries/{id}/replay`.

**Step 2: Filter by Zapier.** Continue only if `data intent` *(Text) Exactly matches* `interested`. Add `question` with an OR rule if you want those too.

**Step 3: Webhooks by Zapier → Custom Request** (get the lead)

| Field | Value |
|---|---|
| Method | GET |
| URL | `BASE/leads/{{data__lead_id}}` |

**Step 4: Webhooks by Zapier → Custom Request** (get the thread, for their words)

| Field | Value |
|---|---|
| Method | GET |
| URL | `BASE/threads/{{data__chat_id}}?limit=5` |

**Step 5: Slack → Send Channel Message**

```
:star: Interested reply from {{3. data full_name}} ({{3. data title}}, {{3. data company}})
"{{1. data summary}}"
Last message: {{4. data last_message_preview}}
Open: https://app.capitalxai.com/outreach/inbox/{{1. data chat_id}}
```

For a CRM instead of Slack, replace step 5 with **HubSpot → Create or Update Contact** (email = `{{3. data email_work}}`) followed by **Create Engagement / Note** with the summary.

The payload Zapier receives:

```json
{ "event": "message.classified", "workspace_id": "…", "at": "2026-09-20T09:14:03Z",
  "data": { "id": "…", "chat_id": "…", "lead_id": "…", "intent": "interested", "confidence": 0.93, "summary": "Wants a call next week" } }
```

Optional signature check: use **Catch Raw Hook** instead of Catch Hook, then a **Code by Zapier (JavaScript)** step:

```js
const crypto = require("crypto");
const expected = crypto.createHmac("sha256", "YOUR_WEBHOOK_SECRET").update(inputData.raw_body).digest("hex");
if (expected !== inputData.signature) throw new Error("bad signature");   // map signature to the x-signature header
return JSON.parse(inputData.raw_body);
```

---

## 2. New row in Google Sheets → create lead → enrol

Sheet columns: `linkedin_url`, `first_name`, `last_name`, `company`, `title`, `email`.

**Trigger: Google Sheets → New Spreadsheet Row.**

**Step 2: Custom Request** (create or update the lead)

| Field | Value |
|---|---|
| Method | POST |
| URL | `BASE/leads` |
| Headers | common + `Idempotency-Key` = `lead-{{Row ID}}` |
| Data | see below |

```json
{
  "linkedin_url": "{{linkedin_url}}",
  "first_name": "{{first_name}}",
  "last_name": "{{last_name}}",
  "company": "{{company}}",
  "title": "{{title}}",
  "email": "{{email}}",
  "source": "zapier-sheet"
}
```

Empty cells are safe: an empty value never blanks a field on an existing lead. If the `email` cell can be empty, remove that line or Zapier will send `""`, which fails the email format check.

**Step 3: Custom Request** (preview)

| Field | Value |
|---|---|
| Method | POST |
| URL | `BASE/enrollments/preview` |
| Data | `{"sequence_id":"YOUR_SEQUENCE_ID","lead_ids":["{{2. data id}}"]}` |

**Step 4: Filter by Zapier.** Continue only if `3. data eligible` *(Number) Greater than* `0`. When it stops here, `3. data excluded` says why (already enrolled, suppressed, replied recently).

**Step 5: Custom Request** (commit)

| Field | Value |
|---|---|
| Method | POST |
| URL | `BASE/enrollments` |
| Headers | common + `Idempotency-Key` = `enrol-{{Row ID}}` |
| Data | `{"sequence_id":"YOUR_SEQUENCE_ID","lead_ids":["{{2. data id}}"],"confirm":true}` |

The commit checks every rule again, so a lead that replied between step 3 and step 5 is skipped and shows up in `skipped_replied`. Find `YOUR_SEQUENCE_ID` with `GET BASE/sequences`.

---

## 3. Found an email → fill it on the lead

Use this when another tool (Clay, Apollo, Hunter, a VA's sheet) finds work emails. It covers the find-email step until that step is configured in your workspace.

**Trigger:** whatever produces the email, for example **Google Sheets → New or Updated Spreadsheet Row** with columns `lead_id` (or `linkedin_url`) and `work_email`.

**If you have the lead id: Custom Request**

| Field | Value |
|---|---|
| Method | PATCH |
| URL | `BASE/leads/{{lead_id}}` |
| Headers | common + `Idempotency-Key` = `email-{{lead_id}}` |
| Data | `{"email_work":"{{work_email}}"}` |

**If you only have the LinkedIn URL: Custom Request**

| Field | Value |
|---|---|
| Method | POST |
| URL | `BASE/leads` |
| Data | `{"linkedin_url":"{{linkedin_url}}","email_work":"{{work_email}}"}` |

Only `email_work` changes. Name, company, stage, tags and custom fields stay as they are. If the lead already has a work email it is kept, and the response lists `email_work` under `unchanged_fields`.

---

## 4. Meeting booked → CRM deal

**Trigger: Webhooks by Zapier → Catch Hook**, registered for `meeting.booked`:

```bash
curl -X POST "$BASE/webhooks" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://hooks.zapier.com/hooks/catch/123456/ghijkl/","events":["meeting.booked"]}'
```

Payload: `data.lead_id`, `data.sender_id`, `data.provider` (calendly, cal.com), `data.starts_at`, `data.booking_id`.

**Step 2: Custom Request** — `GET BASE/leads/{{data__lead_id}}`

**Step 3: HubSpot → Create or Update Contact** — Email `{{2. data email_work}}`, First name, Last name, Company, Job title from step 2.

**Step 4: HubSpot → Create Deal**

| Field | Value |
|---|---|
| Deal name | `{{2. data company}} – {{2. data full_name}}` |
| Deal stage | Appointment scheduled |
| Close date | `{{1. data starts_at}}` |
| Associate with contact | the contact from step 3 |

For Pipedrive use **Create Person** then **Create Deal**. For Salesforce, **Create Record → Opportunity**.

**Step 5 (optional): Custom Request** to move the lead's stage

| Field | Value |
|---|---|
| Method | PUT |
| URL | `BASE/leads/{{data__lead_id}}/stage` |
| Data | `{"stage_id":"YOUR_MEETING_STAGE_ID"}` |

Stage ids come from `GET BASE/me`.
