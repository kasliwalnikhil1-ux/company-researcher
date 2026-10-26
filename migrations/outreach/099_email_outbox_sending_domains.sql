-- =============================================================================
-- 099 — One sending path for every platform email (custom-sending-domain-PRD.md v1.2, phases 1–3 + the data for 4)
--
--   outreach_email_types          the catalogue (§3): audience · domain rule · safety-critical. sendEmail refuses unknown keys.
--   outreach_email_outbox         every email is a row first (§5.1, §5.3); outreach-email-outbox sends it, retries it, falls back.
--   outreach_email_log            delivery events from the Resend webhook (§5.4); 13 months; the Email log page reads it.
--   outreach_sending_domains      a workspace's (or a client's) own domain on our Resend account (§4, §6); state machine in §9.
--   outreach_sending_domain_keys  the domain-scoped Resend API key, encrypted by the edge function (no pgsodium on this project).
--
-- Domain choice (§5.2) is one function, outreach_email_domain_for(); the holder rule from sender-lifecycle-PRD v1.2 §5.8.1 is
-- in it too: a holder email to a member goes from the platform like any team email, only an outside holder gets the brand.
-- Naming: the build prefixes everything with outreach_ (the PRD's `private.*` / `ops.*` schemas do not exist here).
-- Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/099_email_outbox_sending_domains.sql
-- Requires 096 (sender lifecycle) and 084 (cron dispatcher).
-- =============================================================================

create or replace function outreach__patch_fn(p_fn regprocedure, p_marker text, p_old text, p_new text) returns void language plpgsql as $$
declare def text := replace(pg_get_functiondef(p_fn), chr(13), '');
begin
  p_old := replace(p_old, chr(13), ''); p_new := replace(p_new, chr(13), '');
  if position(p_marker in def) > 0 then return; end if;
  if position(p_old in def) = 0 then raise exception '%: anchor not found, patch not applied: %', p_fn, left(p_old, 80); end if;
  execute replace(def, p_old, p_new);
end $$;

-- the sign-in email of a user, read at send time (never copied anywhere)
create or replace function outreach_user_email(p_user uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select lower(u.email::text) from auth.users u where u.id = p_user
$$;
revoke execute on function outreach_user_email(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1. Catalogue
-- -----------------------------------------------------------------------------
create table if not exists outreach_email_types (
  key             text primary key,
  audience        text not null check (audience in ('team','holder','client','auth','platform')),
  domain_rule     text not null check (domain_rule in ('platform','brand')),
  safety_critical boolean not null default false,
  template        text not null,            -- the renderer in the edge code (information for the log page)
  preference      text,                     -- outreach_notification_prefs.kind that can turn it off (null = always)
  note            text
);
alter table outreach_email_types enable row level security;
revoke all on outreach_email_types from public, anon;
grant select on outreach_email_types to authenticated, service_role;
drop policy if exists outreach_email_types_read on outreach_email_types;
create policy outreach_email_types_read on outreach_email_types for select to authenticated using (true);

insert into outreach_email_types(key, audience, domain_rule, safety_critical, template, preference, note) values
  -- team: members of the workspace, always on their sign-in email, always from the platform (D7)
  ('team_invite',                 'team', 'platform', false, 'notify.notifyInvitation',          null, 'platform FR-WS-04'),
  ('reply_alert',                 'team', 'platform', false, 'notes.replyAlertEmail',            'reply_new', 'reply notifications'),
  ('mention',                     'team', 'platform', false, 'notes.mentionEmail',               'note_mention', 'private notes'),
  ('ai_handoff',                  'team', 'platform', false, 'ai_reply.handoffEmail',            'ai_handoff', 'AI replies'),
  ('ai_handback',                 'team', 'platform', false, 'ai_reply.handbackEmail',           'ai_handoff', 'AI replies: the person came back'),
  ('ai_reply_scheduled',          'team', 'platform', false, 'ai_reply.scheduledEmail',          'ai_handoff', 'AI replies: review window'),
  ('ai_reply_cancelled',          'team', 'platform', false, 'ai_reply.cancelledEmail',          'ai_handoff', 'AI replies: a scheduled reply was cancelled'),
  ('ai_reply_breaker',            'team', 'platform', false, 'ai_reply.notifyBreaker',           null, 'AI replies: Auto switched back to Review'),
  ('assignment',                  'team', 'platform', false, 'notes.assignmentEmail',            'assigned', 'inbox assignment'),
  ('manager_daily_digest',        'team', 'platform', false, 'ai_reply.dailySummary',            null, 'AI replies §13.3'),
  ('sequence_stalled',            'team', 'platform', false, 'notify.notifyWorkspace',           null, 'platform alerts'),
  ('sender_running_dry',          'team', 'platform', false, 'notify.notifyWorkspace',           null, 'platform alerts'),
  ('import_failed',               'team', 'platform', false, 'notify.notifyWorkspace',           null, 'platform alerts'),
  ('sender_paused',               'team', 'platform', false, 'notify.notifySender',              null, 'health pause'),
  ('sender_error',                'team', 'platform', false, 'notify.notifySender',              null, 'repeated provider errors'),
  ('sender_level_up',             'team', 'platform', false, 'notify.notifySender',              null, 'warm-up level'),
  ('removal_pending',             'team', 'platform', false, 'lifecycle.emailRemovalStuck',      null, 'sender lifecycle §3.4'),
  ('sender_auto_remove_team',     'team', 'platform', false, 'lifecycle.emailAutoRemoveNotice',  null, 'sender lifecycle §5.6 (team copy)'),
  ('sender_owner_action',         'team', 'platform', false, 'lifecycle.notifyManagersOwnerAction', null, 'the holder used their link'),
  ('health_alert',                'team', 'platform', false, 'health.alertEmail',                null, 'health page'),
  ('sender_disconnected_team',    'team', 'platform', false, 'alerts.teamEmail',                 'sender_disconnected', 'sender lifecycle §5.8.3: combined, 4 h after the sign-in email'),
  ('sender_mass_disconnect',      'team', 'platform', true,  'alerts.massDisconnectEmail',       null, 'sender lifecycle §5.8.4'),
  ('weekly_digest',               'team', 'platform', false, 'reports_email.digestHtml',         null, 'reports'),
  ('sender_weekly',               'team', 'platform', false, 'reports_email.senderReportHtml',   null, 'reports'),
  ('voice_minutes',               'team', 'platform', false, 'voice.minutesEmail',               null, 'website voice minutes'),
  ('export_ready',                'team', 'platform', false, 'exports.readyEmail',               null, 'platform FR-IO-02'),
  ('webchat_handoff',             'team', 'platform', false, 'webchat.handoffEmail',             'webchat_message', 'website chat needs a person'),
  -- billing: owners + billing contacts, platform, never off
  ('billing_payment_failed',      'team', 'platform', true,  'billing_emails.payment_failed',    null, 'sender lifecycle §5.9.2 day 0'),
  ('billing_action_required',     'team', 'platform', true,  'billing_emails.payment_action_required', null, 'bank confirmation'),
  ('billing_reminder',            'team', 'platform', true,  'billing_emails.past_due_reminder', null, 'day 3'),
  ('billing_suspension_tomorrow', 'team', 'platform', true,  'billing_emails.suspension_tomorrow', null, 'day 6'),
  ('billing_suspended',           'team', 'platform', true,  'billing_emails.suspended',         null, 'day 7'),
  ('billing_removal_warning',     'team', 'platform', true,  'billing_emails.removal_warning',   null, 'day 14'),
  ('billing_accounts_removed',    'team', 'platform', true,  'billing_emails.accounts_removed',  null, 'day 21'),
  ('billing_deletion_warning',    'team', 'platform', true,  'billing_emails.deletion_warning',  null, 'day 60 / cancellation day 53'),
  ('billing_data_deleted',        'team', 'platform', true,  'billing_emails.data_deleted',      null, 'day 67'),
  ('billing_reactivated',         'team', 'platform', true,  'billing_emails.reactivated',       null, 'payment recovered'),
  ('billing_plan_ending',         'team', 'platform', true,  'billing_emails.plan_ending',       null, 'cancellation: period ends'),
  ('billing_subscription_cancelled','team','platform', true, 'billing_emails.subscription_cancelled', null, 'cancellation: period ended'),
  ('billing_trial_ending',        'team', 'platform', true,  'billing_emails.trial_ends_soon',   null, 'trial: 2 days / tomorrow'),
  ('billing_trial_expired',       'team', 'platform', true,  'billing_emails.trial_expired',     null, 'trial ended'),
  ('billing_trial_data_warning',  'team', 'platform', true,  'billing_emails.trial_data',        null, 'trial data deleted in N days'),
  -- holder: whoever signs in to the account (sender lifecycle §5.8.1). The only emails that may reach an outside address.
  ('sender_connect_request',      'holder', 'brand', false, 'inbound.connectRequestEmail',       null, 'platform US-01'),
  ('sender_connected_notice',     'holder', 'brand', true,  'lifecycle.connectedNotice',         null, 'outside holders only: "{workspace} connected your account"'),
  ('sender_reconnect_needed',     'holder', 'brand', true,  'notify.notifySender',               null, 'sign-in link (F6)'),
  ('sender_reconnect_manual',     'holder', 'brand', true,  'notify.notifySender',               null, 'cookie retries failed'),
  ('sender_reconnect_reminder',   'holder', 'brand', true,  'notify.notifySender',               null, 'day 1 and day 3'),
  ('ai_reply_consent_request',    'holder', 'brand', true,  'ai_reply.consentRequestEmail',      null, 'AI replies §4.1 (outside holders only)'),
  ('ai_reply_consent_confirmed',  'holder', 'brand', true,  'ai_reply.consentConfirmedEmail',    null, 'AI replies: how to turn them off'),
  ('ai_reply_owner_digest',       'holder', 'brand', false, 'ai_reply.ownerDigest',              null, 'members only (sender lifecycle open question 9)'),
  ('profile_authority_request',   'holder', 'brand', true,  'profile.authorityRequestEmail',     null, 'profile management §4.2 (outside holders only)'),
  ('profile_change_applied',      'holder', 'brand', true,  'profile.changeAppliedEmail',        null, 'profile management §4.3'),
  ('profile_change_proposed',     'holder', 'brand', true,  'profile.changeProposedEmail',       null, 'profile management: approve a change'),
  ('sender_removed_notice',       'holder', 'brand', true,  'lifecycle.notifyOwnerRemoved',      null, 'sender lifecycle §3.4 step 5'),
  ('sender_auto_remove_notice',   'holder', 'brand', true,  'lifecycle.emailAutoRemoveNotice',   null, 'sender lifecycle §5.6'),
  ('sender_erase_notice',         'holder', 'brand', true,  'lifecycle.eraseNotice',             null, 'sender lifecycle §3.5'),
  ('sender_holder_changed',       'holder', 'brand', true,  'lifecycle.holderChangedEmail',      null, 'sender lifecycle §5.8.1'),
  ('sender_removal_billing_notice','holder','brand', true,  'lifecycle.removalBillingNotice',    null, 'sender lifecycle §5.9.2 day 14'),
  ('sender_reconnect_after_billing','holder','brand', true, 'lifecycle.reconnectAfterBilling',   null, 'sender lifecycle §5.9.4'),
  -- client: client viewers and client contacts
  ('client_viewer_invite',        'client', 'brand', false, 'notify.notifyInvitation',           null, 'platform §11.3'),
  ('client_report',               'client', 'brand', false, 'reports_email.clientReportHtml',    null, 'reports'),
  ('webchat_transcript',          'client', 'brand', false, 'webchat.transcriptEmail',           null, 'website chat: the visitor asked for a copy'),
  ('webchat_continuity',          'client', 'brand', false, 'webchat.continuityEmail',           null, 'website chat: unread answer for a visitor who left'),
  -- auth: Supabase Auth through the Send Email hook (D8)
  ('auth_magic_link',             'auth', 'brand', true, 'auth.magicLink',        null, 'Supabase Auth'),
  ('auth_signup',                 'auth', 'brand', true, 'auth.signup',           null, 'Supabase Auth'),
  ('auth_recovery',               'auth', 'brand', true, 'auth.recovery',         null, 'Supabase Auth'),
  ('auth_invite',                 'auth', 'brand', true, 'auth.invite',           null, 'Supabase Auth'),
  ('auth_email_change',           'auth', 'brand', true, 'auth.emailChange',      null, 'Supabase Auth'),
  ('auth_reauthentication',       'auth', 'brand', true, 'auth.reauthentication', null, 'Supabase Auth'),
  -- platform: the operators (OUTREACH_PLATFORM_ALERT_EMAIL, health page recipients)
  ('platform_alert',              'platform', 'platform', true, 'billing_emails.platformAlert', null, 'operator alerts'),
  ('health_urgent',               'platform', 'platform', true, 'health_email.urgent',          null, 'health page'),
  ('health_daily',                'platform', 'platform', false, 'health_email.daily',          null, 'health page'),
  ('sending_domain_records',      'team', 'platform', false, 'sending_domain.recordsEmail',     null, 'the DNS records, emailed to an IT person'),
  ('sending_domain_status',       'team', 'platform', true,  'sending_domain.statusEmail',      null, 'domain paused / failed / verified'),
  ('sending_domain_test',         'client', 'brand', false, 'sending_domain.testEmail',        null, 'the test send from a new domain')
on conflict (key) do update set audience = excluded.audience, domain_rule = excluded.domain_rule, safety_critical = excluded.safety_critical,
  template = excluded.template, preference = excluded.preference, note = excluded.note;

-- -----------------------------------------------------------------------------
-- 2. Sending domains
-- -----------------------------------------------------------------------------
create table if not exists outreach_sending_domains (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references outreach_workspaces(id) on delete cascade,
  client_id         uuid references outreach_clients(id) on delete cascade,     -- null = the workspace's domain
  domain            citext not null,
  resend_domain_id  text,
  resend_api_key_id text,
  region            text not null default 'eu-west-1',
  state             text not null default 'setup' check (state in ('setup','verifying','ready','active','paused','failed','removed')),
  resend_status     text,                                      -- not_started | pending | verified | failed | temporary_failure
  records           jsonb not null default '[]'::jsonb,        -- [{record, type, name, value, priority, ttl, status}]
  from_name         text,
  from_local_part   text not null default 'notifications' check (from_local_part ~ '^[a-z0-9._-]{1,64}$'),
  reply_to          citext,
  branding          jsonb not null default '{}'::jsonb,        -- {logo_path, accent, footer}
  dmarc_found       boolean,
  verified_at       timestamptz,
  activated_at      timestamptz,
  paused_at         timestamptz,
  paused_reason     text check (paused_reason is null or paused_reason in ('send_error','dns','bounces','complaints','manual','plan')),
  paused_detail     text,
  warmup_started_at timestamptz,
  daily_cap         int,                                       -- null = no cap
  last_checked_at   timestamptz,
  failed_at         timestamptz,
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  removed_at        timestamptz
);
create unique index if not exists outreach_sending_domains_live_domain on outreach_sending_domains(domain) where state <> 'removed';
create unique index if not exists outreach_sending_domains_one_per_scope on outreach_sending_domains(workspace_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)) where state <> 'removed';
create unique index if not exists outreach_sending_domains_resend_id on outreach_sending_domains(resend_domain_id) where resend_domain_id is not null and state <> 'removed';
create index if not exists outreach_sending_domains_ws_idx on outreach_sending_domains(workspace_id) where state <> 'removed';

create table if not exists outreach_sending_domain_keys (
  sending_domain_id uuid primary key references outreach_sending_domains(id) on delete cascade,
  api_key_enc       text not null,       -- AES-GCM with the deployment key (same scheme as sender cookies)
  created_at        timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 3. Outbox and log
-- -----------------------------------------------------------------------------
create table if not exists outreach_email_outbox (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid references outreach_workspaces(id) on delete cascade,  -- null for auth emails before a workspace exists, and operator alerts
  client_id         uuid,
  sender_id         uuid references outreach_senders(id) on delete set null,     -- holder emails: which account this is about
  type              text not null references outreach_email_types(key),
  audience          text not null,
  safety_critical   boolean not null default false,
  outside_holder    boolean not null default false,                             -- a holder email to an address outside the workspace
  copy_of           uuid,                                                       -- the "Copy: sent to …" sent to the connecting member points at the holder's row
  to_address        citext not null,
  subject           text not null,
  html              text,
  text_body         text,
  sending_domain_id uuid references outreach_sending_domains(id) on delete set null,   -- null = PLATFORM
  from_address      text not null,
  reply_to          text,
  idempotency_key   text not null,
  status            text not null default 'queued' check (status in ('queued','sending','sent','failed','cancelled')),
  attempts          int not null default 0,
  next_attempt_at   timestamptz not null default now(),
  locked_at         timestamptz,
  fell_back         boolean not null default false,
  fallback_reason   text,
  resend_email_id   text,
  last_error        text,
  created_at        timestamptz not null default now(),
  sent_at           timestamptz,
  data              jsonb not null default '{}'::jsonb                           -- small template facts for the log page (never the body)
);
create unique index if not exists outreach_email_outbox_idem on outreach_email_outbox(coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), idempotency_key);
create index if not exists outreach_email_outbox_due on outreach_email_outbox(next_attempt_at) where status in ('queued','sending');
create index if not exists outreach_email_outbox_resend on outreach_email_outbox(resend_email_id) where resend_email_id is not null;
create index if not exists outreach_email_outbox_domain_day on outreach_email_outbox(sending_domain_id, created_at) where sending_domain_id is not null;
create index if not exists outreach_email_outbox_sender on outreach_email_outbox(sender_id, created_at desc) where sender_id is not null;

create table if not exists outreach_email_log (
  outbox_id        uuid primary key references outreach_email_outbox(id) on delete cascade,
  workspace_id     uuid,
  client_id        uuid,
  sender_id        uuid,
  type             text not null,
  audience         text not null,
  subject          text not null,
  to_address       citext not null,
  from_address     text not null,
  sending_domain_id uuid,
  fell_back        boolean not null default false,
  fallback_reason  text,
  delivery_status  text not null default 'sent' check (delivery_status in ('sent','delivered','delayed','bounced','complained','failed','suppressed')),
  bounce_type      text,
  events           jsonb not null default '[]'::jsonb,
  sent_at          timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists outreach_email_log_ws_idx on outreach_email_log(workspace_id, updated_at desc);
create index if not exists outreach_email_log_ws_type_idx on outreach_email_log(workspace_id, type, updated_at desc);
create index if not exists outreach_email_log_to_idx on outreach_email_log(to_address);
create index if not exists outreach_email_log_sender_idx on outreach_email_log(sender_id, sent_at desc) where sender_id is not null;
create index if not exists outreach_email_log_domain_idx on outreach_email_log(sending_domain_id, sent_at desc) where sending_domain_id is not null;

do $$ declare t text; begin
  foreach t in array array['outreach_sending_domains','outreach_sending_domain_keys','outreach_email_outbox','outreach_email_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on %I to service_role', t);
  end loop;
end $$;

-- plan features (PRD D9): Scale = one workspace domain; Enterprise = also one per client (10)
insert into outreach_plan_features(plan, feature, enabled, limit_value) values
  ('launch', 'custom_sending_domain', false, null), ('scale', 'custom_sending_domain', true, null), ('enterprise', 'custom_sending_domain', true, null),
  ('launch', 'client_sending_domains', false, null), ('scale', 'client_sending_domains', false, null), ('enterprise', 'client_sending_domains', true, 10)
on conflict (plan, feature) do update set enabled = excluded.enabled, limit_value = excluded.limit_value;

-- -----------------------------------------------------------------------------
-- 4. Domain choice (§5.2) and the brand list
-- -----------------------------------------------------------------------------
-- {platform: bool, domain_id, domain, from_address, from_name, reply_to, branding, fallback_reason, state}
create or replace function outreach_email_domain_for(p_type text, p_ws uuid, p_client uuid default null, p_outside boolean default true) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare t outreach_email_types%rowtype; d outreach_sending_domains%rowtype; sent_today int; reason text := null;
        platform jsonb := jsonb_build_object('platform', true, 'domain_id', null, 'fallback_reason', null);
begin
  select * into t from outreach_email_types where key = p_type;
  if not found then raise exception 'E_PAYLOAD_INVALID: unknown email type %', p_type; end if;
  if t.domain_rule = 'platform' or p_ws is null then return platform; end if;
  -- a holder email to a member is a team email (sender lifecycle §5.8.1 / sending domain §3)
  if t.audience = 'holder' and not coalesce(p_outside, true) then return platform; end if;
  if not outreach_has_feature(p_ws, 'custom_sending_domain') then return platform || jsonb_build_object('fallback_reason', 'plan'); end if;
  select * into d from outreach_sending_domains x where x.workspace_id = p_ws and x.client_id = p_client and p_client is not null and x.state <> 'removed' limit 1;
  if not found then select * into d from outreach_sending_domains x where x.workspace_id = p_ws and x.client_id is null and x.state <> 'removed' limit 1; end if;
  if not found then return platform; end if;
  if d.state <> 'active' then return platform || jsonb_build_object('fallback_reason', d.state, 'domain_id', d.id); end if;
  if d.paused_at is not null then return platform || jsonb_build_object('fallback_reason', coalesce(d.paused_reason, 'paused'), 'domain_id', d.id); end if;
  if d.daily_cap is not null then
    select count(*) into sent_today from outreach_email_outbox o where o.sending_domain_id = d.id and o.created_at >= date_trunc('day', now()) and o.status in ('sending','sent','queued');
    if sent_today >= d.daily_cap then return platform || jsonb_build_object('fallback_reason', 'warmup_cap', 'domain_id', d.id); end if;
  end if;
  return jsonb_build_object('platform', false, 'domain_id', d.id, 'domain', d.domain::text, 'from_address', d.from_local_part || '@' || d.domain::text,
    'from_name', d.from_name, 'reply_to', d.reply_to::text, 'branding', d.branding, 'client_id', d.client_id, 'fallback_reason', null, 'state', d.state);
end $$;
revoke execute on function outreach_email_domain_for(text, uuid, uuid, boolean) from public, anon, authenticated;

-- the read-only lists on the Email sending page: which types use the workspace domain, which always come from the platform
create or replace function outreach_email_types_by_rule() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'brand', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'audience', audience, 'safety_critical', safety_critical, 'note', note) order by audience, key), '[]') from outreach_email_types where domain_rule = 'brand' and audience <> 'auth'),
    'platform', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'audience', audience, 'safety_critical', safety_critical, 'note', note) order by audience, key), '[]') from outreach_email_types where domain_rule = 'platform' and audience <> 'platform'),
    'auth', (select coalesce(jsonb_agg(key order by key), '[]') from outreach_email_types where audience = 'auth'))
$$;
grant execute on function outreach_email_types_by_rule() to authenticated;
revoke execute on function outreach_email_types_by_rule() from public, anon;

-- -----------------------------------------------------------------------------
-- 5. Outbox: enqueue, claim, result (§5.3)
-- -----------------------------------------------------------------------------
-- p: {workspace_id, client_id, sender_id, type, to, subject, html, text, idempotency_key, outside_holder, copy_of, data,
--     direct (true = the caller already sent it; row stored as sent with resend_email_id), from_address, sending_domain_id, fell_back, fallback_reason}
create or replace function outreach_email_enqueue(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare t outreach_email_types%rowtype; ws uuid := nullif(p->>'workspace_id','')::uuid; cl uuid := nullif(p->>'client_id','')::uuid; sid uuid := nullif(p->>'sender_id','')::uuid;
        idem text := nullif(p->>'idempotency_key',''); choice jsonb; o outreach_email_outbox%rowtype; existing outreach_email_outbox%rowtype;
        outside boolean := coalesce((p->>'outside_holder')::boolean, false); addr text := lower(trim(p->>'to')); from_addr text; direct boolean := coalesce((p->>'direct')::boolean, false);
        pref text; pref_user uuid := nullif(p->>'recipient_user_id','')::uuid; pref_on boolean; dom_id uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into t from outreach_email_types where key = p->>'type';
  if not found then raise exception 'E_PAYLOAD_INVALID: unknown email type %', coalesce(p->>'type', '(none)'); end if;
  if addr is null or addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E_PAYLOAD_INVALID: "%" is not an email address', addr; end if;
  if nullif(p->>'subject','') is null then raise exception 'E_PAYLOAD_INVALID: subject required'; end if;
  if t.audience = 'holder' and sid is null then raise exception 'E_PAYLOAD_INVALID: a holder email names its sender'; end if;
  -- a team email a person turned off (safety-critical types have no preference)
  if t.preference is not null and not t.safety_critical and ws is not null and pref_user is not null then
    select pr.email into pref_on from outreach_notification_prefs pr where pr.user_id = pref_user and pr.workspace_id = ws and pr.kind = t.preference;
    if pref_on is false then return jsonb_build_object('skipped', 'preference', 'type', t.key, 'to', addr); end if;
  end if;
  if idem is null then idem := t.key || ':' || encode(digest(addr || '|' || coalesce(p->>'subject','') || '|' || coalesce(p->>'html',''), 'sha256'), 'hex'); end if;
  select * into existing from outreach_email_outbox where coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(ws, '00000000-0000-0000-0000-000000000000'::uuid) and idempotency_key = idem;
  if found then return jsonb_build_object('outbox_id', existing.id, 'duplicate', true, 'status', existing.status); end if;

  if p ? 'from_address' then
    choice := jsonb_build_object('platform', coalesce((p->>'platform')::boolean, nullif(p->>'sending_domain_id','') is null), 'domain_id', nullif(p->>'sending_domain_id','')::uuid, 'from_address', p->>'from_address', 'reply_to', p->>'reply_to', 'fallback_reason', p->>'fallback_reason');
  else
    choice := outreach_email_domain_for(t.key, ws, cl, outside);
  end if;
  from_addr := coalesce(choice->>'from_address', 'platform');
  -- a platform choice that names a domain is a fallback (paused, not active, warm-up cap): the row carries no domain
  dom_id := case when coalesce((choice->>'platform')::boolean, true) then null else (choice->>'domain_id')::uuid end;
  insert into outreach_email_outbox(workspace_id, client_id, sender_id, type, audience, safety_critical, outside_holder, copy_of, to_address, subject, html, text_body,
                                    sending_domain_id, from_address, reply_to, idempotency_key, status, attempts, fell_back, fallback_reason, resend_email_id, sent_at, data)
  values (ws, cl, sid, t.key, t.audience, t.safety_critical, outside, nullif(p->>'copy_of','')::uuid, addr, p->>'subject', p->>'html', p->>'text',
          dom_id, from_addr, coalesce(p->>'reply_to', choice->>'reply_to'), idem,
          case when direct then case when coalesce((p->>'ok')::boolean, true) then 'sent' else 'failed' end else 'queued' end,
          case when direct then 1 else 0 end, coalesce((p->>'fell_back')::boolean, dom_id is null and coalesce(p->>'fallback_reason', choice->>'fallback_reason') is not null), coalesce(p->>'fallback_reason', choice->>'fallback_reason'),
          nullif(p->>'resend_email_id',''), case when direct and coalesce((p->>'ok')::boolean, true) then now() end, coalesce(p->'data', '{}'::jsonb))
  returning * into o;
  if direct then
    if o.status = 'sent' then
      insert into outreach_email_log(outbox_id, workspace_id, client_id, sender_id, type, audience, subject, to_address, from_address, sending_domain_id, fell_back, fallback_reason, sent_at)
      values (o.id, o.workspace_id, o.client_id, o.sender_id, o.type, o.audience, o.subject, o.to_address, o.from_address, o.sending_domain_id, o.fell_back, o.fallback_reason, now())
      on conflict (outbox_id) do nothing;
    else
      update outreach_email_outbox set last_error = left(p->>'error', 500) where id = o.id;
    end if;
  end if;
  return jsonb_build_object('outbox_id', o.id, 'duplicate', false, 'status', o.status, 'from_address', o.from_address, 'platform', o.sending_domain_id is null,
    'sending_domain_id', o.sending_domain_id, 'fallback_reason', o.fallback_reason);
end $$;
revoke execute on function outreach_email_enqueue(jsonb) from public, anon, authenticated;

-- due rows, locked for this worker; a row stuck in `sending` for 10 minutes (a crash mid-send) is taken again
create or replace function outreach_email_outbox_claim(p_limit int default 50)
returns table(id uuid, workspace_id uuid, client_id uuid, sender_id uuid, type text, audience text, safety_critical boolean, to_address text, subject text, html text, text_body text,
              sending_domain_id uuid, from_address text, reply_to text, idempotency_key text, attempts int, fell_back boolean, api_key_enc text, domain text, from_name text, domain_reply_to text)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
  with due as (
    select o.id from outreach_email_outbox o
     where (o.status = 'queued' and o.next_attempt_at <= now()) or (o.status = 'sending' and o.locked_at < now() - interval '10 minutes')
     order by o.safety_critical desc, o.next_attempt_at
     limit greatest(1, least(p_limit, 200)) for update skip locked),
  upd as (update outreach_email_outbox o set status = 'sending', locked_at = now() from due where o.id = due.id returning o.*)
  select u.id, u.workspace_id, u.client_id, u.sender_id, u.type, u.audience, u.safety_critical, u.to_address::text, u.subject, u.html, u.text_body,
         u.sending_domain_id, u.from_address, u.reply_to, u.idempotency_key, u.attempts, u.fell_back, k.api_key_enc, d.domain::text, d.from_name, d.reply_to::text
    from upd u left join outreach_sending_domains d on d.id = u.sending_domain_id left join outreach_sending_domain_keys k on k.sending_domain_id = d.id;
end $$;
revoke execute on function outreach_email_outbox_claim(int) from public, anon, authenticated;

-- the platform From for a row that falls back (the edge function passes it: the address lives in its environment)
-- p_outcome: sent | domain_error | transient | invalid | no_transport
create or replace function outreach_email_outbox_result(p_id uuid, p_outcome text, p_resend_id text default null, p_error text default null, p_platform_from text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare o outreach_email_outbox%rowtype; wait interval; res jsonb := '{}'::jsonb; paused_domain uuid := null; to_platform boolean := false;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into o from outreach_email_outbox where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_outcome = 'sent' then
    update outreach_email_outbox set status = 'sent', sent_at = now(), attempts = attempts + 1, resend_email_id = coalesce(p_resend_id, resend_email_id), last_error = null, locked_at = null, html = html where id = p_id;
    insert into outreach_email_log(outbox_id, workspace_id, client_id, sender_id, type, audience, subject, to_address, from_address, sending_domain_id, fell_back, fallback_reason, sent_at)
    values (o.id, o.workspace_id, o.client_id, o.sender_id, o.type, o.audience, o.subject, o.to_address, o.from_address, o.sending_domain_id, o.fell_back, o.fallback_reason, now())
    on conflict (outbox_id) do update set sent_at = now(), from_address = excluded.from_address, fell_back = excluded.fell_back, fallback_reason = excluded.fallback_reason, delivery_status = 'sent', updated_at = now();
    return jsonb_build_object('ok', true, 'status', 'sent');
  end if;
  if p_outcome = 'invalid' then
    update outreach_email_outbox set status = 'failed', attempts = attempts + 1, last_error = left(coalesce(p_error, 'invalid recipient'), 500), locked_at = null where id = p_id;
    return jsonb_build_object('ok', true, 'status', 'failed');
  end if;
  if p_outcome = 'domain_error' and o.sending_domain_id is not null then
    -- the customer's domain is not usable: pause it, tell the owners, and send this very email from the platform now (§5.3 step 3)
    update outreach_sending_domains set paused_at = coalesce(paused_at, now()), paused_reason = coalesce(paused_reason, 'send_error'), paused_detail = left(coalesce(p_error, ''), 300), updated_at = now()
     where id = o.sending_domain_id and paused_at is null returning id into paused_domain;
    to_platform := true;
  elsif p_outcome in ('transient', 'no_transport') then
    -- a safety-critical email that still has not left after the third try goes from the platform (§5.3 step 4)
    if o.safety_critical and o.sending_domain_id is not null and o.attempts + 1 >= 3 then to_platform := true; end if;
  end if;
  if to_platform then
    update outreach_email_outbox set status = 'queued', attempts = attempts + 1, next_attempt_at = now(), locked_at = null, sending_domain_id = null,
           from_address = coalesce(p_platform_from, 'platform'), reply_to = null, fell_back = true,
           fallback_reason = case when p_outcome = 'domain_error' then 'send_error' else 'retries' end, last_error = left(coalesce(p_error, ''), 500)
     where id = p_id;
    return jsonb_build_object('ok', true, 'status', 'queued', 'fell_back', true, 'domain_paused', paused_domain, 'domain_id', o.sending_domain_id);
  end if;
  if o.attempts + 1 >= 5 or (p_outcome = 'domain_error' and o.sending_domain_id is null) then
    update outreach_email_outbox set status = 'failed', attempts = attempts + 1, last_error = left(coalesce(p_error, p_outcome), 500), locked_at = null where id = p_id;
    return jsonb_build_object('ok', true, 'status', 'failed', 'attempts', o.attempts + 1);
  end if;
  wait := case o.attempts when 0 then interval '30 seconds' when 1 then interval '2 minutes' when 2 then interval '10 minutes' else interval '1 hour' end;
  update outreach_email_outbox set status = 'queued', attempts = attempts + 1, next_attempt_at = now() + wait, locked_at = null, last_error = left(coalesce(p_error, p_outcome), 500) where id = p_id;
  return jsonb_build_object('ok', true, 'status', 'queued', 'retry_in', wait::text, 'attempts', o.attempts + 1);
end $$;
revoke execute on function outreach_email_outbox_result(uuid, text, text, text, text) from public, anon, authenticated;

-- a domain that was removed, paused or re-resolved: queued rows pointing at it go back through the chooser (§9)
create or replace function outreach_email_outbox_reroute(p_domain uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int := 0; o record; c jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for o in select id, type, workspace_id, client_id, outside_holder from outreach_email_outbox where sending_domain_id = p_domain and status = 'queued' loop
    c := outreach_email_domain_for(o.type, o.workspace_id, o.client_id, o.outside_holder);
    update outreach_email_outbox set sending_domain_id = (c->>'domain_id')::uuid, from_address = coalesce(c->>'from_address', 'platform'), reply_to = c->>'reply_to',
           fell_back = coalesce((c->>'platform')::boolean, true), fallback_reason = c->>'fallback_reason' where id = o.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function outreach_email_outbox_reroute(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Delivery events (§5.4) and the bounce task
-- -----------------------------------------------------------------------------
create or replace function outreach_email_event(p_resend_id text, p_event text, p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare o outreach_email_outbox%rowtype; l outreach_email_log%rowtype; st text; bt text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into o from outreach_email_outbox where resend_email_id = p_resend_id order by created_at desc limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_email'); end if;
  st := case p_event when 'email.sent' then 'sent' when 'email.delivered' then 'delivered' when 'email.delivery_delayed' then 'delayed' when 'email.bounced' then 'bounced'
                     when 'email.complained' then 'complained' when 'email.failed' then 'failed' when 'email.suppressed' then 'suppressed' else null end;
  if st is null then return jsonb_build_object('ok', false, 'reason', 'unknown_event'); end if;
  bt := case when p_event = 'email.bounced' then coalesce(p_payload#>>'{bounce,type}', p_payload#>>'{bounce,subType}', p_payload->>'type') end;
  insert into outreach_email_log(outbox_id, workspace_id, client_id, sender_id, type, audience, subject, to_address, from_address, sending_domain_id, fell_back, fallback_reason, sent_at)
  values (o.id, o.workspace_id, o.client_id, o.sender_id, o.type, o.audience, o.subject, o.to_address, o.from_address, o.sending_domain_id, o.fell_back, o.fallback_reason, coalesce(o.sent_at, now()))
  on conflict (outbox_id) do nothing;
  update outreach_email_log
     set delivery_status = case when delivery_status in ('bounced','complained','suppressed') and st in ('sent','delivered','delayed') then delivery_status else st end,
         bounce_type = coalesce(bt, bounce_type),
         events = (events || jsonb_build_array(jsonb_build_object('event', p_event, 'at', coalesce(p_payload->>'created_at', now()::text), 'detail', coalesce(p_payload->'bounce', p_payload->'failed', '{}'::jsonb)))),
         updated_at = now()
   where outbox_id = o.id returning * into l;
  return jsonb_build_object('ok', true, 'outbox_id', o.id, 'workspace_id', o.workspace_id, 'sender_id', o.sender_id, 'type', o.type, 'audience', o.audience,
    'safety_critical', o.safety_critical, 'outside_holder', o.outside_holder, 'to', o.to_address::text, 'delivery_status', l.delivery_status, 'hard_bounce', (p_event = 'email.bounced' and coalesce(bt, '') not ilike '%transient%' and coalesce(bt, '') not ilike '%soft%'),
    'sending_domain_id', o.sending_domain_id);
end $$;
revoke execute on function outreach_email_event(text, text, jsonb) from public, anon, authenticated;

-- a hard bounce (or suppression) on a holder email: a task for the connecting member (or the owners) and the managers (§5.4)
create or replace function outreach_email_bounce_task(p_outbox uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare o outreach_email_outbox%rowtype; s outreach_senders%rowtype; tid uuid; assignee uuid; title text; body text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into o from outreach_email_outbox where id = p_outbox;
  if not found or o.audience <> 'holder' or o.sender_id is null then return null; end if;
  select * into s from outreach_senders where id = o.sender_id;
  if not found then return null; end if;
  if exists (select 1 from outreach_tasks t where t.sender_id = s.id and t.completed_at is null and t.node_id = 'email_bounce') then return null; end if;
  if o.outside_holder then
    assignee := coalesce(s.connected_by, (select m.user_id from outreach_members m where m.workspace_id = s.workspace_id and m.role = 'owner' order by m.created_at limit 1));
    title := 'The sign-in email to ' || o.to_address || ' bounced';
    body := 'The ' || replace(o.type, '_', ' ') || ' email for ' || coalesce(s.display_name, 'this account') || ' could not be delivered to ' || o.to_address || '. Check who signs in to this account (sender page → Whose account) and send a new sign-in link.';
  else
    assignee := (select m.user_id from outreach_members m where m.workspace_id = s.workspace_id and m.role = 'owner' order by m.created_at limit 1);
    title := 'A sign-in email to a teammate bounced (' || o.to_address || ')';
    body := 'The email for ' || coalesce(s.display_name, 'this account') || ' went to ' || o.to_address || ', the sign-in email of the member who holds it, and bounced. Their login email is wrong: ask them to update it.';
  end if;
  insert into outreach_tasks(workspace_id, client_id, kind, sender_id, node_id, title, body, due_at, assigned_to, source)
  values (s.workspace_id, s.client_id, 'follow_up', s.id, 'email_bounce', title, body, now() + interval '2 days', assignee, 'system') returning id into tid;
  insert into outreach_sender_events(sender_id, kind, data) values (s.id, 'lifecycle', jsonb_build_object('action', 'holder_email_bounced', 'to', o.to_address, 'type', o.type, 'task_id', tid));
  perform outreach_audit(s.workspace_id, 'email.holder_bounced', 'sender', s.id::text, jsonb_build_object('to', o.to_address, 'type', o.type, 'task_id', tid), 'system');
  return tid;
end $$;
revoke execute on function outreach_email_bounce_task(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. Reads for the app (owners and managers)
-- -----------------------------------------------------------------------------
create or replace function outreach_email_log_search(p_ws uuid, p_to text default null, p_type text default null, p_status text default null,
                                                     p_since timestamptz default null, p_until timestamptz default null, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare rows jsonb; total int;
begin
  perform outreach_require(p_ws, 'manager');
  select count(*) into total from outreach_email_log l
   where l.workspace_id = p_ws and (p_to is null or l.to_address::text ilike '%' || lower(p_to) || '%') and (p_type is null or l.type = p_type)
     and (p_status is null or l.delivery_status = p_status) and (p_since is null or l.sent_at >= p_since) and (p_until is null or l.sent_at <= p_until);
  select coalesce(jsonb_agg(jsonb_build_object('id', l.outbox_id, 'at', l.sent_at, 'type', l.type, 'audience', l.audience, 'subject', l.subject, 'to', l.to_address::text,
           'from', l.from_address, 'fell_back', l.fell_back, 'fallback_reason', l.fallback_reason, 'status', l.delivery_status, 'bounce_type', l.bounce_type, 'events', l.events,
           'sender_id', l.sender_id, 'client_id', l.client_id, 'domain', d.domain::text) order by l.sent_at desc), '[]'::jsonb)
    into rows
    from (select * from outreach_email_log l
           where l.workspace_id = p_ws and (p_to is null or l.to_address::text ilike '%' || lower(p_to) || '%') and (p_type is null or l.type = p_type)
             and (p_status is null or l.delivery_status = p_status) and (p_since is null or l.sent_at >= p_since) and (p_until is null or l.sent_at <= p_until)
           order by l.sent_at desc limit greatest(1, least(coalesce(p_limit, 100), 500))) l
    left join outreach_sending_domains d on d.id = l.sending_domain_id;
  return jsonb_build_object('total', total, 'rows', rows);
end $$;
grant execute on function outreach_email_log_search(uuid, text, text, text, timestamptz, timestamptz, int) to authenticated;
revoke execute on function outreach_email_log_search(uuid, text, text, text, timestamptz, timestamptz, int) from public, anon;

-- the sender page line: "Sign-in email to priya@client.com · bounced 26 Oct"
create or replace function outreach_email_log_sender_last(p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; r record;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  select l.type, l.to_address::text as to_address, l.delivery_status, l.sent_at, l.updated_at, l.bounce_type, o.outside_holder into r
    from outreach_email_log l join outreach_email_outbox o on o.id = l.outbox_id
   where l.sender_id = p_sender and l.audience = 'holder' and o.copy_of is null order by l.sent_at desc limit 1;
  if not found then return null; end if;
  return jsonb_build_object('type', r.type, 'to', r.to_address, 'status', r.delivery_status, 'sent_at', r.sent_at, 'updated_at', r.updated_at, 'bounce_type', r.bounce_type, 'outside', r.outside_holder);
end $$;
grant execute on function outreach_email_log_sender_last(uuid) to authenticated;
revoke execute on function outreach_email_log_sender_last(uuid) from public, anon;

-- the workspace's domains (and its clients') for the Email sending page; keys never leave the database
create or replace function outreach_sending_domains(p_ws uuid, p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare out jsonb;
begin
  perform outreach_require(p_ws, 'manager');
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'workspace_id', d.workspace_id, 'client_id', d.client_id, 'domain', d.domain::text, 'region', d.region, 'state', d.state,
           'resend_status', d.resend_status, 'records', d.records, 'from_name', d.from_name, 'from_local_part', d.from_local_part, 'reply_to', d.reply_to::text, 'branding', d.branding,
           'dmarc_found', d.dmarc_found, 'verified_at', d.verified_at, 'activated_at', d.activated_at, 'paused_at', d.paused_at, 'paused_reason', d.paused_reason, 'paused_detail', d.paused_detail,
           'warmup_started_at', d.warmup_started_at, 'daily_cap', d.daily_cap, 'last_checked_at', d.last_checked_at, 'failed_at', d.failed_at, 'created_at', d.created_at,
           'sent_today', (select count(*) from outreach_email_outbox o where o.sending_domain_id = d.id and o.created_at >= date_trunc('day', now()) and o.status in ('sending','sent','queued')),
           'last7', (select jsonb_build_object('sent', count(*), 'delivered', count(*) filter (where l.delivery_status = 'delivered'), 'bounced', count(*) filter (where l.delivery_status = 'bounced'),
                                               'complained', count(*) filter (where l.delivery_status = 'complained')) from outreach_email_log l where l.sending_domain_id = d.id and l.sent_at > now() - interval '7 days'),
           'fallbacks7', (select count(*) from outreach_email_log l where l.workspace_id = d.workspace_id and l.fell_back and l.sent_at > now() - interval '7 days')
         ) order by d.client_id nulls first, d.created_at), '[]'::jsonb)
    into out
    from outreach_sending_domains d where d.workspace_id = p_ws and d.state <> 'removed' and (p_client is null or d.client_id = p_client);
  return jsonb_build_object('domains', out, 'feature', outreach_has_feature(p_ws, 'custom_sending_domain'), 'client_domains', outreach_has_feature(p_ws, 'client_sending_domains'),
    'client_domain_limit', outreach_plan_limit(p_ws, 'client_sending_domains'), 'min_plan', outreach__plan_label(outreach_feature_min_plan('custom_sending_domain')));
end $$;
grant execute on function outreach_sending_domains(uuid, uuid) to authenticated;
revoke execute on function outreach_sending_domains(uuid, uuid) from public, anon;

-- the checks before anything is created (§4.1 step 1); the edge function runs the same before calling Resend
create or replace function outreach_sending_domain_check(p_ws uuid, p_domain text, p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare d text := lower(trim(coalesce(p_domain, ''))); errors jsonb := '[]'::jsonb; warnings jsonb := '[]'::jsonb; labels text[]; root text; clash record; lim int; used int;
begin
  perform outreach_require(p_ws, 'manager');
  if d = '' or d !~ '^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then errors := errors || to_jsonb('Enter a hostname such as notify.yourcompany.com'::text); end if;
  labels := string_to_array(d, '.');
  if array_length(labels, 1) > 4 then errors := errors || to_jsonb('Use at most two levels under your domain (for example notify.mail.yourcompany.com)'::text); end if;
  if not outreach_has_feature(p_ws, 'custom_sending_domain') then errors := errors || to_jsonb(('Available on ' || outreach__plan_label(outreach_feature_min_plan('custom_sending_domain')) || '. Your own sending domain is not part of the ' || outreach__plan_label(outreach_feature_plan(p_ws)) || ' plan.')::text); end if;
  if p_client is not null then
    if not outreach_has_feature(p_ws, 'client_sending_domains') then errors := errors || to_jsonb('A domain per client is part of the Enterprise plan.'::text); end if;
    lim := outreach_plan_limit(p_ws, 'client_sending_domains');
    select count(*) into used from outreach_sending_domains x where x.workspace_id = p_ws and x.client_id is not null and x.state <> 'removed';
    if lim is not null and used >= lim then errors := errors || to_jsonb(('Your plan includes ' || lim || ' client domains. Contact support for more.')::text); end if;
  end if;
  if exists (select 1 from outreach_sending_domains x where x.domain = d::citext and x.state <> 'removed' and x.workspace_id <> p_ws) then
    errors := errors || to_jsonb('This domain is in use by another GrowthxAI workspace. Contact support'::text);
  end if;
  if exists (select 1 from outreach_sending_domains x where x.domain = d::citext and x.state <> 'removed' and x.workspace_id = p_ws and coalesce(x.client_id, '00000000-0000-0000-0000-000000000000'::uuid) <> coalesce(p_client, '00000000-0000-0000-0000-000000000000'::uuid)) then
    errors := errors || to_jsonb('This domain is already set up in this workspace. Use a different subdomain for this client.'::text);
  end if;
  if array_length(labels, 1) <= 2 then warnings := warnings || to_jsonb('This is your root domain. A subdomain like notify.' || d || ' keeps these emails apart from your other mail.'); end if;
  -- the domain (or its root) is one a mailbox sender sends outreach from
  root := case when array_length(labels, 1) >= 2 then labels[array_length(labels, 1) - 1] || '.' || labels[array_length(labels, 1)] end;
  for clash in select lower(split_part(coalesce(s.owner_email::text, s.public_identifier, ''), '@', 2)) as dom from outreach_senders s
                where s.workspace_id = p_ws and s.deleted_at is null and s.provider::text in ('GMAIL','OUTLOOK','IMAP') and s.status::text not in ('removed','erased') loop
    if clash.dom <> '' and (clash.dom = d or clash.dom = root or d like '%.' || clash.dom) then
      warnings := warnings || to_jsonb(('This looks like the domain you send outreach from (' || clash.dom || '). Use a subdomain like notify.' || coalesce(root, d) || ' so outreach complaints don''t affect these emails.')::text);
      exit;
    end if;
  end loop;
  return jsonb_build_object('ok', jsonb_array_length(errors) = 0, 'domain', d, 'errors', errors, 'warnings', warnings, 'root', root);
end $$;
grant execute on function outreach_sending_domain_check(uuid, text, uuid) to authenticated;
revoke execute on function outreach_sending_domain_check(uuid, text, uuid) from public, anon;

-- -----------------------------------------------------------------------------
-- 8. Housekeeping: retention (§6), warm-up caps (§5.6), health signals (§5.5), plan pauses (§9)
-- -----------------------------------------------------------------------------
create or replace function outreach_email_retention() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n_bodies int; n_log int; n_outbox int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_email_outbox set html = null, text_body = null where created_at < now() - interval '30 days' and (html is not null or text_body is not null);
  get diagnostics n_bodies = row_count;
  delete from outreach_email_log where sent_at < now() - interval '13 months';
  get diagnostics n_log = row_count;
  delete from outreach_email_outbox where created_at < now() - interval '13 months';
  get diagnostics n_outbox = row_count;
  return jsonb_build_object('bodies_cleared', n_bodies, 'log_deleted', n_log, 'outbox_deleted', n_outbox);
end $$;
revoke execute on function outreach_email_retention() from public, anon, authenticated;

-- the daily cap for a domain by its age (50 for 7 days, 200 for the next 7, then none); the nightly run writes it
create or replace function outreach__sending_domain_cap(p_started timestamptz) returns int language sql immutable as $$
  select case when p_started is null then 50 when p_started > now() - interval '7 days' then 50 when p_started > now() - interval '14 days' then 200 else null end
$$;

-- health per active domain over the last 7 days (§5.5): returns the domains to pause with the reason; the caller pauses + notifies
create or replace function outreach_sending_domains_health() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare d record; out jsonb := '[]'::jsonb; sends int; bounces int; complaints int; reason text; detail text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  -- warm-up caps follow the calendar
  update outreach_sending_domains set daily_cap = outreach__sending_domain_cap(warmup_started_at), updated_at = now() where state = 'active' and daily_cap is distinct from outreach__sending_domain_cap(warmup_started_at);
  for d in select * from outreach_sending_domains where state = 'active' and paused_at is null loop
    select count(*), count(*) filter (where delivery_status = 'bounced' and coalesce(bounce_type, '') not ilike '%transient%' and coalesce(bounce_type, '') not ilike '%soft%'), count(*) filter (where delivery_status = 'complained')
      into sends, bounces, complaints from outreach_email_log where sending_domain_id = d.id and sent_at > now() - interval '7 days';
    reason := null;
    if sends >= 25 and bounces::numeric / sends > 0.04 then reason := 'bounces'; detail := bounces || ' hard bounces out of ' || sends || ' emails in 7 days (' || round(100.0 * bounces / sends, 1) || '%)';
    elsif complaints >= 3 or (sends >= 100 and complaints::numeric / sends > 0.001) then reason := 'complaints'; detail := complaints || ' spam complaints in 7 days'; end if;
    if reason is not null then
      update outreach_sending_domains set paused_at = now(), paused_reason = reason, paused_detail = detail, updated_at = now() where id = d.id;
      perform outreach_audit(d.workspace_id, 'sending_domain.paused', 'sending_domain', d.id::text, jsonb_build_object('reason', reason, 'detail', detail), 'system');
      out := out || jsonb_build_object('id', d.id, 'workspace_id', d.workspace_id, 'domain', d.domain::text, 'reason', reason, 'detail', detail);
    end if;
  end loop;
  return out;
end $$;
revoke execute on function outreach_sending_domains_health() from public, anon, authenticated;

-- plan downgraded below Scale (§9): pause with 'plan'; back on the plan: resume. Called by the nightly run and the plan-change path.
create or replace function outreach_sending_domains_plan_sync() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n_paused int := 0; n_resumed int := 0; n_removed int := 0; d record;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for d in select x.* from outreach_sending_domains x where x.state in ('active','ready','verifying','setup') and x.paused_at is null and not outreach_has_feature(x.workspace_id, 'custom_sending_domain') loop
    update outreach_sending_domains set paused_at = now(), paused_reason = 'plan', paused_detail = 'The plan no longer includes a sending domain', updated_at = now() where id = d.id;
    perform outreach_audit(d.workspace_id, 'sending_domain.paused', 'sending_domain', d.id::text, jsonb_build_object('reason', 'plan'), 'system');
    n_paused := n_paused + 1;
  end loop;
  for d in select x.* from outreach_sending_domains x where x.paused_reason = 'plan' and x.state <> 'removed' and outreach_has_feature(x.workspace_id, 'custom_sending_domain')
                                                        and outreach_plan_active(x.workspace_id) loop
    update outreach_sending_domains set paused_at = null, paused_reason = null, paused_detail = null, updated_at = now() where id = d.id;
    perform outreach_audit(d.workspace_id, 'sending_domain.resumed', 'sending_domain', d.id::text, jsonb_build_object('reason', 'plan_restored'), 'system');
    n_resumed := n_resumed + 1;
  end loop;
  -- 30 days below the plan: the domain row goes to 'removed' here; the edge function deletes it on Resend (state removed + resend_domain_id still set)
  update outreach_sending_domains set state = 'removed', removed_at = now(), updated_at = now() where paused_reason = 'plan' and paused_at < now() - interval '30 days' and state <> 'removed';
  get diagnostics n_removed = row_count;
  return jsonb_build_object('paused', n_paused, 'resumed', n_resumed, 'removed', n_removed);
end $$;
revoke execute on function outreach_sending_domains_plan_sync() from public, anon, authenticated;

-- the platform admin's health card (§8.3)
create or replace function outreach_email_platform_stats() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() and not platform_is_admin(auth.uid()) then raise exception 'E_FORBIDDEN'; end if;
  return jsonb_build_object(
    'domains', (select coalesce(jsonb_object_agg(state, n), '{}') from (select state, count(*) n from outreach_sending_domains group by state) x),
    'outbox_backlog', (select count(*) from outreach_email_outbox where status in ('queued','sending')),
    'outbox_overdue', (select count(*) from outreach_email_outbox where status in ('queued','sending') and next_attempt_at < now() - interval '5 minutes'),
    'failed_24h', (select count(*) from outreach_email_outbox where status = 'failed' and created_at > now() - interval '24 hours'),
    'sent_24h', (select count(*) from outreach_email_log where sent_at > now() - interval '24 hours'),
    'fell_back_7d', (select count(*) from outreach_email_log where fell_back and sent_at > now() - interval '7 days'),
    'brand_7d', (select count(*) from outreach_email_log where sending_domain_id is not null and sent_at > now() - interval '7 days'),
    'bounced_7d', (select count(*) from outreach_email_log where delivery_status = 'bounced' and sent_at > now() - interval '7 days'),
    'complained_7d', (select count(*) from outreach_email_log where delivery_status = 'complained' and sent_at > now() - interval '7 days'),
    'auth_failed_24h', (select count(*) from outreach_email_outbox where type like 'auth_%' and status = 'failed' and created_at > now() - interval '24 hours'),
    'auth_sent_24h', (select count(*) from outreach_email_outbox where type like 'auth_%' and status = 'sent' and created_at > now() - interval '24 hours'));
end $$;
grant execute on function outreach_email_platform_stats() to authenticated;
revoke execute on function outreach_email_platform_stats() from public, anon;

-- -----------------------------------------------------------------------------
-- 9. Scheduling: the outbox worker on the dispatcher (guarded, every 15 s), domain verification every 10 min while a domain
--    is verifying (guarded), the nightly domain run at 04:00 UTC
-- -----------------------------------------------------------------------------
insert into outreach_cron_jobs (name, fn, body, every_s, guarded, note) values
  ('email-outbox',          'outreach-email-outbox',           '{"mode":"tick"}',   15,  true, 'queued platform emails due in outreach_email_outbox (custom-sending-domain-PRD §5.3)'),
  ('sending-domains-verify','outreach-worker-sending-domains', '{"mode":"verify"}', 600, true, 'sending domains still verifying (72 h every 10 min, then hourly for 7 days)')
on conflict (name) do update set fn = excluded.fn, body = excluded.body, every_s = excluded.every_s, guarded = excluded.guarded, note = excluded.note;

select outreach__patch_fn('public.outreach_cron_has_work(text)'::regprocedure, $q$when 'email-outbox' then$q$,
$q$    when 'inbound' then exists$q$,
$q$    when 'email-outbox' then exists (select 1 from outreach_email_outbox o where (o.status = 'queued' and o.next_attempt_at <= now()) or (o.status = 'sending' and o.locked_at < now() - interval '10 minutes'))
    when 'sending-domains-verify' then exists (select 1 from outreach_sending_domains d where d.state in ('setup','verifying') and d.resend_domain_id is not null
                                                and d.created_at > now() - interval '7 days'
                                                and (d.last_checked_at is null or d.last_checked_at < now() - case when d.created_at > now() - interval '72 hours' then interval '9 minutes' else interval '59 minutes' end))
    when 'inbound' then exists$q$);

do $$ begin perform cron.unschedule('outreach-sending-domains-daily'); exception when others then null; end $$;
select cron.schedule('outreach-sending-domains-daily', '0 4 * * *', $$select outreach_invoke('outreach-worker-sending-domains', '{"mode":"daily"}'::jsonb)$$);

-- the outbox can be bypassed (every sendEmail sends at once and only logs) if the worker ever has to be taken out
insert into outreach_flags(key, value) values ('email_outbox_enabled', 'true'::jsonb) on conflict (key) do nothing;

drop function if exists outreach__patch_fn(regprocedure, text, text, text);
