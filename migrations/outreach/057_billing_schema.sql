-- =============================================================================
-- Outreach Platform — 057 billing v2 schema (pricing-billing-PRD.md §9)
--   Plans Launch / Scale / Enterprise, prepaid accounts, plan and account changes, trial 7 days / 1 account,
--   disconnect instead of pause at trial end, early-supporter ledger, Stripe event log.
-- Run after 056 (enum value 'disconnected'). Idempotent.
--
-- Rollout switch: nothing in this migration changes what a workspace can do until the platform flag
-- `billing_enforced` is turned on (Settings → Admin → Billing, localhost only). While it is off every workspace keeps
-- unlimited accounts and every feature, exactly like the pre-billing build. See docs/outreach/BILLING.md.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Plans
-- -----------------------------------------------------------------------------
alter table outreach_workspaces drop constraint if exists outreach_workspaces_plan_check;
update outreach_workspaces set plan = case plan when 'team' then 'launch' when 'agency' then 'scale' when 'agency_plus' then 'enterprise' else plan end
 where plan in ('team','agency','agency_plus');

-- the plan a suspended / cancelled workspace returns to. It lived in `settings`, which owners can edit; it is a column now.
alter table outreach_workspaces add column if not exists plan_before_suspension text;
update outreach_workspaces
   set plan_before_suspension = coalesce(plan_before_suspension, case settings->>'plan_before_suspension' when 'team' then 'launch' when 'agency' then 'scale' when 'agency_plus' then 'enterprise'
                                                                                                           when 'launch' then 'launch' when 'scale' then 'scale' when 'enterprise' then 'enterprise' end),
       settings = settings - 'plan_before_suspension'
 where settings ? 'plan_before_suspension';

alter table outreach_workspaces add constraint outreach_workspaces_plan_check
  check (plan in ('trial','trial_expired','launch','scale','enterprise','suspended','cancelled'));
alter table outreach_workspaces drop constraint if exists outreach_workspaces_plan_before_check;
alter table outreach_workspaces add constraint outreach_workspaces_plan_before_check
  check (plan_before_suspension is null or plan_before_suspension in ('trial','launch','scale','enterprise'));
alter table outreach_workspaces alter column trial_ends_at set default now() + interval '7 days';
comment on column outreach_workspaces.plan is 'trial | trial_expired | launch | scale | enterprise | suspended | cancelled';

alter table outreach_workspaces
  add column if not exists billing_period       text,
  add column if not exists accounts_requested   int,
  add column if not exists accounts_billed      int,
  add column if not exists trial_account_limit  int  not null default 1,
  add column if not exists current_period_start timestamptz,
  add column if not exists current_period_end   timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists cancelled_at         timestamptz,
  add column if not exists data_delete_after    timestamptz,
  add column if not exists scheduled_change     jsonb,     -- {plan, accounts_billed, accounts_requested, billing_period, effective_at, keep_sender_ids[]}
  add column if not exists pending_payment      jsonb,     -- {invoice_id, hosted_invoice_url, change_id, change, created_at}; the client secret is never stored
  add column if not exists stripe_schedule_id   text,
  add column if not exists price_version        text not null default 'v1',
  add column if not exists early_supporter_tier int,
  add column if not exists early_supporter_discount numeric(3,2) not null default 0,
  add column if not exists custom_price_id      text,      -- Enterprise custom deals: a Stripe price made for this workspace
  add column if not exists billing_comp         boolean not null default false,   -- plan set by an admin, no Stripe subscription (PRD §14 #37)
  add column if not exists disputed_at          timestamptz,
  add column if not exists suspended_at         timestamptz;

do $$ begin
  alter table outreach_workspaces add constraint outreach_workspaces_billing_period_check check (billing_period is null or billing_period in ('monthly','quarterly','annual'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table outreach_workspaces add constraint outreach_workspaces_accounts_requested_check check (accounts_requested is null or accounts_requested >= 1);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table outreach_workspaces add constraint outreach_workspaces_accounts_billed_check check (accounts_billed is null or accounts_billed >= 1);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table outreach_workspaces add constraint outreach_workspaces_early_discount_check check (early_supporter_discount in (0, 0.10, 0.30, 0.50));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table outreach_workspaces add constraint outreach_workspaces_trial_limit_check check (trial_account_limit >= 0);
exception when duplicate_object then null; end $$;
create unique index if not exists outreach_workspaces_stripe_sub_idx on outreach_workspaces(stripe_subscription_id) where stripe_subscription_id is not null;
create index if not exists outreach_workspaces_stripe_customer_idx on outreach_workspaces(stripe_customer_id) where stripe_customer_id is not null;

-- Owners could update every column of their workspace row through RLS, including `plan`. From here on a signed-in user may
-- only change the name and the settings; plan, accounts and every Stripe field are written by the service role and by
-- security-definer functions.
revoke update on outreach_workspaces from authenticated, anon;
grant update (name, settings) on outreach_workspaces to authenticated;
revoke insert, delete on outreach_workspaces from authenticated, anon;

-- -----------------------------------------------------------------------------
-- Price book and plan features (rows come from pricing/v1.json through 058_billing_seed.sql)
-- -----------------------------------------------------------------------------
create table if not exists outreach_price_book (
  version        text not null,              -- 'v1'
  plan           text not null check (plan in ('launch','scale','enterprise')),
  billing_period text not null check (billing_period in ('monthly','quarterly','annual')),
  step_min       int  not null,              -- 1, 5, 10, 20, 50, 100
  per_account_monthly numeric(8,2) not null, -- monthly-equivalent price of one account at this step
  stripe_price_lookup_key text not null,     -- e.g. scale_annual_v1
  primary key (version, plan, billing_period, step_min)
);

create table if not exists outreach_plan_features (
  plan        text not null check (plan in ('launch','scale','enterprise')),
  feature     text not null,
  enabled     boolean not null,
  limit_value int,                           -- e.g. webchat_inboxes 1 / 3 / null (no limit)
  primary key (plan, feature)
);

create table if not exists outreach_early_supporter_tiers (
  tier     int primary key,
  spots    int not null check (spots > 0),
  discount numeric(3,2) not null check (discount in (0.10, 0.30, 0.50)),
  coupon   text not null                     -- Stripe coupon id (duration = forever)
);

-- -----------------------------------------------------------------------------
-- Account slots
-- -----------------------------------------------------------------------------
-- A sign-in link holds one account for its lifetime, so two links opened at once cannot both take the last free account.
create table if not exists outreach_slot_reservations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  sender_id    uuid references outreach_senders(id) on delete cascade,
  purpose      text not null check (purpose in ('hosted_auth','mailbox','re_enable','reconnect')),
  expires_at   timestamptz not null,
  released_at  timestamptz,
  release_reason text,                       -- completed | expired | failed | replaced | manual
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index if not exists outreach_slot_reservations_open_idx on outreach_slot_reservations(workspace_id) where released_at is null;
create index if not exists outreach_slot_reservations_sender_idx on outreach_slot_reservations(sender_id) where released_at is null;

-- every time an account slot is taken or freed: the swap count per month comes from here (PRD §6.3)
create table if not exists outreach_slot_events (
  id           bigserial primary key,
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  sender_id    uuid,
  kind         text not null check (kind in ('taken','freed')),
  reason       text,
  at           timestamptz not null default now()
);
create index if not exists outreach_slot_events_ws_idx on outreach_slot_events(workspace_id, at desc);

-- -----------------------------------------------------------------------------
-- Billing changes, Stripe events
-- -----------------------------------------------------------------------------
create table if not exists outreach_billing_changes (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  requested_by  uuid references auth.users(id) on delete set null,
  kind          text not null default 'change',   -- change | checkout | cancel | resume | cancel_scheduled | admin
  from_state    jsonb not null,              -- {plan, accounts_billed, billing_period}
  to_state      jsonb not null,
  immediate     jsonb,                       -- part applied now
  scheduled     jsonb,                       -- part applied at renewal
  quote         jsonb not null,              -- {charge_today_cents, next_invoice_cents, next_invoice_at, lines[], proration_date}
  keep_sender_ids uuid[],
  status        text not null check (status in ('quoted','applied','scheduled','pending_payment','failed','cancelled')),
  error         text,
  stripe_invoice_id text,
  expires_at    timestamptz,                 -- a quote is good for 15 minutes
  applied_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists outreach_billing_changes_ws_idx on outreach_billing_changes(workspace_id, created_at desc);
-- quotes that were never confirmed are noise after a day; the nightly job removes them
create index if not exists outreach_billing_changes_quoted_idx on outreach_billing_changes(created_at) where status = 'quoted';

create table if not exists outreach_billing_events (
  stripe_event_id text primary key,
  workspace_id    uuid references outreach_workspaces(id) on delete set null,
  type            text not null,
  payload         jsonb not null,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  error           text
);
create index if not exists outreach_billing_events_ws_idx on outreach_billing_events(workspace_id, received_at desc);
create index if not exists outreach_billing_events_unprocessed_idx on outreach_billing_events(received_at) where processed_at is null;

-- one email per kind and period per workspace (trial ending, past due, deletion warnings)
create table if not exists outreach_billing_notices (
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  kind         text not null,
  period_key   text not null,                -- what the notice is about, e.g. the trial end date
  sent_at      timestamptz not null default now(),
  primary key (workspace_id, kind, period_key)
);

-- daily platform report: accounts on the connector vs accounts paid for (PRD §12 #6)
create table if not exists outreach_billing_cost_reports (
  day         date primary key,
  report      jsonb not null,
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Early supporters and trials
-- -----------------------------------------------------------------------------
create table if not exists outreach_early_supporters (
  workspace_id uuid primary key references outreach_workspaces(id) on delete cascade,
  position     int not null unique,          -- 1, 2, 3 … in sign-up order
  tier         int not null,
  discount     numeric(3,2) not null,
  assigned_at  timestamptz not null default now(),
  forfeited_at timestamptz,                  -- the subscription ended: the discount is gone for good
  note         text
);

-- one trial per user and per company email domain (PRD §14 #38). The row outlives the workspace.
create table if not exists outreach_trial_claims (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid,
  email_domain text,                         -- null for free-mail addresses (those are limited per user only)
  workspace_id uuid references outreach_workspaces(id) on delete set null,
  claimed_at   timestamptz not null default now()
);
create index if not exists outreach_trial_claims_user_idx on outreach_trial_claims(user_id);
create index if not exists outreach_trial_claims_domain_idx on outreach_trial_claims(email_domain) where email_domain is not null;

-- -----------------------------------------------------------------------------
-- Senders: disconnect support
-- -----------------------------------------------------------------------------
alter table outreach_senders
  add column if not exists previous_unipile_account_id text,
  add column if not exists disconnected_at   timestamptz,
  add column if not exists billing_paused_at timestamptz,   -- since when it is paused for billing_suspended | billing_cancelled | over_plan_limit
  add column if not exists plan_pause_prev   jsonb;         -- {status, status_reason} before an over_plan_limit pause, to put back exactly
comment on column outreach_senders.status_reason is 'adds over_plan_limit | billing_cancelled | billing_suspended | trial_expired | user_disconnected | RECONNECT_WRONG_ACCOUNT (billing v2)';
create index if not exists outreach_senders_prev_account_idx on outreach_senders(previous_unipile_account_id) where previous_unipile_account_id is not null;

-- connector accounts waiting to be deleted (a deleted account stops costing us from the next connector billing period).
-- Retried with backoff for 24 hours, then the platform admin is alerted (PRD §12.1 step 3).
create table if not exists outreach_account_deletions (
  account_id     text primary key,
  sender_id      uuid,
  workspace_id   uuid,
  reason         text not null,
  attempts       int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error     text,
  created_at     timestamptz not null default now(),
  done_at        timestamptz,
  alerted_at     timestamptz
);
create index if not exists outreach_account_deletions_due_idx on outreach_account_deletions(next_attempt_at) where done_at is null;

-- -----------------------------------------------------------------------------
-- RLS: owners read their own billing history; everything else is service-only (RLS on, no policies)
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array['outreach_price_book','outreach_plan_features','outreach_early_supporter_tiers','outreach_slot_reservations','outreach_slot_events',
    'outreach_billing_changes','outreach_billing_events','outreach_billing_notices','outreach_billing_cost_reports','outreach_early_supporters',
    'outreach_trial_claims','outreach_account_deletions']) loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('revoke insert, update, delete, truncate on %I from authenticated', t);
  end loop;
end $$;
select outreach__policy('outreach_price_book','price_book_select','select','true');
select outreach__policy('outreach_plan_features','plan_features_select','select','true');
select outreach__policy('outreach_billing_changes','billing_changes_select','select','outreach_role_in(workspace_id) = ''owner'' and status <> ''quoted''');

-- -----------------------------------------------------------------------------
-- Platform flags
-- -----------------------------------------------------------------------------
insert into outreach_flags(key, value) values
  ('billing_enforced', 'false'::jsonb),            -- the rollout switch: limits, trial expiry and plan gates apply only when true
  ('billing_data_deletion', 'false'::jsonb)        -- automatic deletion of lapsed workspaces; off until the operator turns it on
on conflict (key) do nothing;

-- old usage table: kept for reporting only; it never sets a Stripe quantity again
comment on table outreach_billing_usage is 'Accounts connected per day (information only since billing v2; never used to set a quantity).';
alter table outreach_billing_usage add column if not exists accounts int not null default 0;
alter table outreach_billing_usage add column if not exists accounts_billed int;
