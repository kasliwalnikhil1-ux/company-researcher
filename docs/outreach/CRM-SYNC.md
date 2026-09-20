# CRM sync: HubSpot, Pipedrive, Salesforce

For the agency admin who connects a CRM, and (last section) for the platform operator who sets up the OAuth apps.

Connect a CRM in **Settings → Integrations**. One workspace can connect one account per CRM. Only owners and managers can connect, change or disconnect an integration.

## What is synced, and when

The sync runs every 5 minutes. "Sync now" on the settings page runs it at once.

### To the CRM (push)

| When this happens here | This happens in the CRM |
|---|---|
| A lead qualifies under the sync rule (see below) | The person is created, or matched to an existing record by email (then by LinkedIn URL). A company is created or matched only for people we create. |
| A message or email is sent or received | It is logged on the person's timeline, with the sequence and step it came from ("LinkedIn message sent · Founders Q3 · Step 2"). Text is cut at 2,000 characters. |
| The person is synced for the first time | One note, "Conversation so far", carries the earlier messages (up to 15) so the CRM record does not start in the middle of a thread. |
| The lead's stage changes | The "Outreach stage" field is updated, and the mapped CRM stage is set (see stage mapping). |
| A reply is classified interested, and "create a deal" is on | One deal is created for the person. Never a second one. |
| A meeting is booked | A note with the time, and the stage mapped to "meeting". |

How each CRM stores this:

| | Person | Company | Timeline entry | Deal |
|---|---|---|---|---|
| HubSpot | Contact | Company (matched by email domain, then name) | LinkedIn message → communication, email → email, anything else → note. If HubSpot refuses one of these, we fall back to a note. | Deal in the first stage of the first pipeline, unless you set a pipeline or stage |
| Pipedrive | Person | Organisation (matched by name) | Note | Deal |
| Salesforce | Lead by default. An existing Contact with the same email is always reused. Set `salesforce_object` to `Contact` to create contacts (with an Account) instead. | Account (contacts only) | Completed task | Opportunity (contacts only). A Salesforce lead cannot hold an opportunity: the log says so, and you convert the lead in Salesforce. |

We do not overwrite your CRM data. On a person who already existed in the CRM we only write the fields we own (Outreach stage, LinkedIn URL, and last intent / sequence / sender if you mapped them). Name, email, title and company are written when we create the person. Turn on `overwrite_existing` in the integration settings if you want every mapped field updated each time.

### From the CRM (pull)

- **Import a list.** Pick a HubSpot list, a Pipedrive people filter, or a Salesforce list view or campaign, and import it as leads. Leads are matched by LinkedIn URL or email, so nobody is duplicated. People with neither are skipped and counted. Up to 5,000 people per run; run it again to continue a larger list. Imported leads have the source `crm:hubspot` (or `crm:pipedrive`, `crm:salesforce`) and stay linked to their CRM record.
- **Customers and open deals blacklist.** See below.

## The three sync rules

| Rule | Who is sent to the CRM |
|---|---|
| **Only leads who replied** (default) | A lead is sent the first time they reply, on LinkedIn or by email. |
| Only interested leads | A lead is sent once a reply is classified interested, a meeting is booked, or the deal is won. |
| Everyone enrolled | A lead is sent when it enters a sequence. |

Why "only leads who replied" is the default: the most common complaint about outreach tools with a CRM connector is that they fill the CRM with thousands of cold contacts nobody has spoken to. That makes the CRM harder to use, and on HubSpot it can push you into a more expensive contact tier. With the default, your CRM stays a list of real conversations.

Two things to know:

- Once a person is linked to a CRM record, they stay in sync whatever the rule says. That includes everyone you imported from the CRM.
- Changing the rule is not retroactive. It applies to what happens from then on.

## Field mapping defaults

Leave the mapping empty to use these. If you save your own mapping, it replaces the defaults, so include every field you want.

| Our field | HubSpot | Pipedrive | Salesforce |
|---|---|---|---|
| First name | `firstname` | | `FirstName` |
| Last name | `lastname` | | `LastName` |
| Full name | | `name` | |
| Work email (personal if there is no work email) | `email` | `email` | `Email` |
| Phone | `phone` | `phone` | `Phone` |
| Job title | `jobtitle` | `job_title` | `Title` |
| Company | `company` | `org_name` (the organisation) | `Company` (on a contact: the Account) |
| Location | `city` | | `City` (on a contact: `MailingCity`) |
| LinkedIn URL | `hs_linkedin_url` | `custom:LinkedIn URL` | no standard field: goes in a note |
| Pipeline stage | `outreach_stage` (automatic) | `custom:Outreach stage` (automatic) | no standard field: goes in a note |

- **Outreach stage.** In HubSpot and Pipedrive we create a text field called "Outreach stage" the first time it is needed and keep it up to date, even if "Pipeline stage" is not in your mapping. If the connected user may not create fields, the stage goes in a note instead. To switch this off, map "Pipeline stage" to nothing or set `write_outreach_stage` to false.
- **Pipedrive targets.** `name`, `email`, `phone`, `job_title`, `org_name`, `custom:<Field name>` (a text field we create if it is missing), or a field's API key.
- **Salesforce targets** are Lead field API names. Custom fields work (`LinkedIn_URL__c`). A custom field that does not exist on the object is left out, and the record is still saved.
- Other fields you can map: personal email, headline, last reply intent, sequence name, sender name, and `custom.<key>` for your own lead fields.
- Empty values are never sent. We do not blank a CRM field.
- A mapped property that does not exist in HubSpot is left out and the contact is still saved.

## Stage mapping defaults

The mapping is keyed by stage kind: new, contacted, connected, replied, interested, meeting, won, lost. Leave it empty to use the defaults. If you save your own mapping, a kind that is missing is not pushed.

| Stage kind | HubSpot lifecycle stage | Pipedrive | Salesforce |
|---|---|---|---|
| replied | `lead` | | |
| interested | `marketingqualifiedlead` | | |
| meeting | `salesqualifiedlead` | | |
| won | `customer` | | |

- The value means: HubSpot lifecycle stage, Pipedrive **deal stage id** (a number), Salesforce **lead status**. Pipedrive and Salesforce start empty because these differ per account.
- Pipedrive people and Salesforce contacts have no stage of their own. For them the stage shows in the "Outreach stage" field, and on the deal if we created one.
- A deal we created follows **won** and **lost** on its own: HubSpot `closedwon` / `closedlost`, Pipedrive won / lost, Salesforce `Closed Won` / `Closed Lost`. If your pipeline uses other names, map them: `{"won": {"contact": "customer", "deal": "your_stage_id"}}`.
- HubSpot only moves a lifecycle stage forward through its API. A move backwards is ignored by HubSpot.

## Customers and open deals blacklist

Turn on "never contact existing customers or open deals" and, every 6 hours, we read from the CRM:

| CRM | What counts |
|---|---|
| HubSpot | Contacts and companies with lifecycle stage Customer, and the contacts and companies on every open deal |
| Pipedrive | People and organisations on open deals and on won deals |
| Salesforce | Accounts whose type starts with "Customer" and their contacts, and the accounts and contacts on every open opportunity |

Their emails, company domains and company names are added to your workspace blacklist with the source `crm:<provider>`. Free mail domains (gmail.com and similar) are never added as a domain.

- These entries block enrolment (you see the count in the enrol preview) and block sending (a lead already in a sequence stops at the next step). They delete nothing: the lead, the timeline and the chat stay.
- Entries that are no longer customers or open deals in the CRM are removed at the next refresh. Entries you added by hand or by CSV are never touched.
- If the CRM list could not be read to the end in one run, new entries are still added but nothing is removed until a complete read. The log says so.
- A deal we create for an interested lead is an open deal too, so that lead is blocked from further automated steps. They had already replied, so their sequence had stopped anyway.

## Reading the sync log

Every write, skip and failure is one row in the sync log, on the integration page and on each lead.

| Status | Meaning | What to do |
|---|---|---|
| ok | The CRM accepted the change. The detail says what changed. | Nothing. |
| skipped | The lead is outside the sync rule, or the CRM cannot do this for that record (for example a deal on a Salesforce lead). | Nothing, unless you expected the lead in the CRM: then check the sync rule. |
| error | The CRM rejected this one record. The detail has the CRM's reason. | Usually a mapped field that does not exist or does not accept the value. Fix the mapping. The sync carries on with the next record. |

- A lead outside the rule is logged as skipped once a day at most, not once per message.
- Operations: `contact.upsert`, `note.create` (timeline entries), `stage.update`, `deal.create`, `list.import`, `suppress.refresh`.
- The short code at the end of a timeline row (`msg:…`) is how we make sure one message is never logged twice.
- **The integration shows "error".** The CRM no longer accepts our access (the user was removed, the app was uninstalled, or the refresh token ran out; Pipedrive's ends after 60 days without use). Click Connect again. Links and the log are kept.
- **"Asked us to slow down".** The CRM's rate limit. The sync stops for this run and continues from the same place 5 minutes later.
- If the CRM is down, the sync waits and tries again. Events are handled in order and are not lost while the integration is active.

## Disconnecting

Disconnect does three things and nothing else:

1. The stored tokens are deleted.
2. The blacklist entries that came from this CRM (source `crm:<provider>`) are removed.
3. The integration is marked disconnected and the sync stops.

Your leads, chats and timelines stay. Records already in the CRM stay. The links between leads and CRM records and the sync log are kept, so connecting the same account again carries on without duplicates. To remove our access on the CRM side too, uninstall the app there (HubSpot: Connected apps. Pipedrive: Tools and apps. Salesforce: Connected apps OAuth usage).

---

## For the platform operator: OAuth app setup

One OAuth app per CRM, shared by all workspaces. Until a CRM's client id and secret are set, its Connect button answers `E_NOT_CONFIGURED` ("not enabled on this platform yet") and everything else keeps working.

**Redirect URL for all three:**

```
<OUTREACH_FUNCTIONS_BASE_URL>outreach-crm-oauth/callback
e.g. https://<project-ref>.supabase.co/functions/v1/outreach-crm-oauth/callback
```

It must match exactly. If `OUTREACH_FUNCTIONS_BASE_URL` is set (custom functions domain), use that base.

| Env var | Needed | Notes |
|---|---|---|
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | for HubSpot | |
| `PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET` | for Pipedrive | |
| `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` | for Salesforce | consumer key and consumer secret |
| `OUTREACH_COOKIE_KEY` | yes | already set for sender secrets; the same key encrypts CRM tokens |
| `OUTREACH_WEB_ORIGIN` | yes | where the callback sends the user back; `return_url` must be on this origin |
| `OUTREACH_CRON_SECRET` | yes | already set; authorises the cron call and derives the PKCE verifier |
| `HUBSPOT_TOKEN_URL` | optional | default `https://api.hubspot.com/oauth/v3/token` |
| `SALESFORCE_LOGIN_URL` | optional | `https://test.salesforce.com` for sandboxes |
| `SALESFORCE_API_VERSION` | optional | default `v62.0` |

### HubSpot

Developer account → create a public app → Auth tab. Set the redirect URL and these **required scopes**:

`oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read`, `crm.objects.companies.write`, `crm.objects.deals.read`, `crm.objects.deals.write`, `crm.lists.read`, `crm.schemas.contacts.write`

The scope list in the app must be the same as the list we request, or HubSpot refuses the install. `crm.schemas.contacts.write` is what lets us create the "Outreach stage" property. We use the OAuth v3 token endpoint; HubSpot switches v1 off on 16 February 2027. An unlisted app can be installed by a limited number of accounts; list it on the marketplace (or get it verified) before a wide rollout.

### Pipedrive

Developer Hub → create an app (private is fine to start) → OAuth & access scopes. Set the callback URL and tick:

`base`, `contacts:full`, `deals:full`, `search:read`, and `admin` (optional: needed to create the "LinkedIn URL" and "Outreach stage" person fields; without it those two values go in a note unless the fields already exist with exactly those names).

Pipedrive scopes are chosen in the app, not in the URL. A private app only installs in its own company account; publish it (unlisted is enough) for customers.

### Salesforce

Setup → App Manager → New External Client App (or Connected App) → enable OAuth. Set the callback URL and:

- Scopes: **Manage user data via APIs (`api`)** and **Perform requests at any time (`refresh_token`, `offline_access`)**.
- Keep **Require Proof Key for Code Exchange (PKCE)** on. We send an S256 challenge.
- Keep **Require secret for web server flow** and **for refresh token flow** on.
- Refresh token policy: "valid until revoked".
- To let other orgs connect, the app must be packaged or distributable (External Client App with distribution state "Packaged", or a Connected App, which is available in every org once created).

The connecting user needs API access, read and write on Leads, Contacts, Accounts, Opportunities and Tasks, and for campaign import the Marketing User checkbox. Optional: create a text field marked External ID on Lead (or Contact), for example `Outreach_Lead_Id__c`, and set `salesforce_external_id_field` in the integration settings. New records are then created with an upsert by that id, which is safe to repeat.

### Deploy and schedule

- Both functions deploy with `--no-verify-jwt` (the callback is public and checks the state itself; the other actions check the user's session in code). `scripts/outreach-deploy-functions.sh` already lists them.
- Cron: `outreach-crm-sync` every 5 minutes through `outreach_invoke` (seeded in `016_seed_cron_v2.sql`).

### Extra integration settings

Saved through `outreach_integration_save` in `settings`, next to `sync_rule`, `log_messages`, `create_deal_on_interested` and `suppress_customers`:

| Key | Default | Meaning |
|---|---|---|
| `overwrite_existing` | false | true: update every mapped field on people that already existed in the CRM |
| `write_outreach_stage` | true | false: no automatic "Outreach stage" field |
| `deal_pipeline`, `deal_stage`, `deal_amount` | none | where new deals go; ids as the CRM names them |
| `salesforce_object` | `Lead` | `Contact` to create contacts and accounts |
| `salesforce_external_id_field` | none | API name of an External ID field to upsert by |
