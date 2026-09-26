-- =============================================================================
-- Outreach Platform — 022 Profile Studio: schema, seeds, RLS, storage
-- Source: linkedin-profile-management-PRD.md (25 Sep 2026). Requires 021 (enum values). Idempotent.
--
-- What lives here
--   * outreach_profile_ceilings          per-field-group frequency limits (PRD §5.1) + the combined limits
--   * profile_edit action ceiling/caps   one identity write a day at most; level-0 senders get 0 (PRD §5.2)
--   * outreach_profile_authority         field-level grants from the sender OWNER (PRD §4.2); unique while unrevoked
--   * outreach_profile_authority_links   signed grant links (hash only), accepted without a login
--   * outreach_profile_snapshots         the platform's own "before/after" ledger with declared fidelity (PRD §1.2, §6)
--   * outreach_profile_changes           a requested change and its lifecycle (PRD §6, §7)
--   * outreach_profile_templates         values with {{variables}} (PRD §8.2)
--   * outreach_profile_bulk_runs         preview → commit runs (one change per sender, PRD §8.2)
--   * outreach_profile_experiments       sender-level randomised experiments (PRD §9)
--   * outreach_profile_qa                QA score + checks (PRD §8.4)
--   * storage bucket outreach-profile-assets (uploaded photos, kept so a rollback can restore the original)
-- Writes to changes/authority/snapshots go through SQL functions (023) or the service role, never PostgREST.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Ceilings (PRD §5.1). 'experience_new' = creating an experience entry; 'all' / 'all_daily' = every group combined.
-- -----------------------------------------------------------------------------
create table if not exists outreach_profile_ceilings (
  field_group  text primary key,
  max_count    int  not null check (max_count >= 0),
  window_days  int  not null check (window_days >= 1),
  rationale    text
);
insert into outreach_profile_ceilings(field_group, max_count, window_days, rationale) values
  ('photo',          1, 30, 'Strongest takeover signal'),
  ('cover',          2, 30, 'Visual, low semantic weight'),
  ('headline',       2,  7, 'The main experiment lever; needs room to test'),
  ('about',          2,  7, null),
  ('experience',     3,  7, 'Editing a description'),
  ('experience_new', 1, 30, 'A person does not change jobs weekly'),
  ('education',      1, 30, null),
  ('location',       1, 90, 'People do not relocate quarterly'),
  ('skills',         2,  7, null),
  ('custom_link',    2,  7, null),
  ('all',            4,  7, 'Prevents a full-profile rewrite in one sitting'),
  ('all_daily',      1,  1, 'One identity write per day')
on conflict (field_group) do update set max_count = excluded.max_count, window_days = excluded.window_days, rationale = excluded.rationale;

-- A profile edit is one action from the daily ledger (competes with outreach volume, PRD §5.1); level 0 cannot edit (PRD §5.2).
select outreach__seed_linkedin_ceilings((select jsonb_agg(jsonb_build_array(t, d, w)) from (values
  ('profile_edit', 1, 4)
) x(t, d, w)));
select outreach__seed_linkedin_warmup((select jsonb_agg(jsonb_build_array(l, 'profile_edit', v)) from (values (0,0),(1,1),(2,1),(3,1),(4,1),(5,1)) x(l, v)));

-- -----------------------------------------------------------------------------
-- Sender columns
-- -----------------------------------------------------------------------------
alter table outreach_senders
  add column if not exists profile_qa_score            smallint check (profile_qa_score between 0 and 100),
  add column if not exists profile_identity_unverified boolean not null default false,   -- PRD §4.4: set by a manager when the account was not connected by its owner
  add column if not exists profile_snapshot_at         timestamptz;

-- -----------------------------------------------------------------------------
-- Authority (PRD §4.2)
-- -----------------------------------------------------------------------------
create table if not exists outreach_profile_authority (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references outreach_workspaces(id) on delete cascade,
  sender_id        uuid not null references outreach_senders(id) on delete cascade,
  field_group      outreach_profile_field_group_t not null,
  mode             text not null check (mode in ('propose_only','direct')),
  granted_by_email citext not null,
  granted_via      text not null check (granted_via in ('signed_link','owner_is_operator')),
  evidence         jsonb not null default '{}',
  granted_at       timestamptz not null default now(),
  expires_at       timestamptz,
  revoked_at       timestamptz,
  revoked_reason   text,
  revoked_by       uuid references auth.users(id)
);
create unique index if not exists outreach_profile_authority_active_uq on outreach_profile_authority(sender_id, field_group) where revoked_at is null;
create index if not exists outreach_profile_authority_ws_idx on outreach_profile_authority(workspace_id, sender_id);

create table if not exists outreach_profile_authority_links (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  sender_id     uuid not null references outreach_senders(id) on delete cascade,
  token_hash    text not null unique,
  field_groups  outreach_profile_field_group_t[] not null,
  mode          text not null check (mode in ('propose_only','direct')),
  owner_email   citext not null,
  expires_at    timestamptz not null,
  grant_days    int,                                   -- how long the resulting grants last (null = no expiry)
  accepted_at   timestamptz,
  declined_at   timestamptz,
  evidence      jsonb,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);
create index if not exists outreach_profile_authority_links_sender_idx on outreach_profile_authority_links(sender_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Templates (PRD §8.2) — before changes, which reference them
-- -----------------------------------------------------------------------------
create table if not exists outreach_profile_templates (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  client_id    uuid references outreach_clients(id) on delete set null,
  name         text not null,
  field_groups outreach_profile_field_group_t[] not null,
  body         jsonb not null,               -- normalised payload with {{variables}}
  variables    jsonb not null default '{}',  -- {name: default}
  created_by   uuid references auth.users(id),
  updated_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists outreach_profile_templates_ws_idx on outreach_profile_templates(workspace_id, name);

-- -----------------------------------------------------------------------------
-- Experiments (PRD §9) — before changes, which reference them
-- -----------------------------------------------------------------------------
create table if not exists outreach_profile_experiments (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references outreach_workspaces(id) on delete cascade,
  name           text not null,
  field_group    outreach_profile_field_group_t not null check (field_group in ('headline','about','photo')),
  variants       jsonb not null,                     -- [{key:'A', value:...}, {key:'B', value:...}]
  sender_ids     uuid[] not null,
  assignment     jsonb not null default '{}',        -- {sender_id: variant_key}
  metric         text not null default 'acceptance_rate',
  washout_days   int not null default 3 check (washout_days between 0 and 30),
  min_invites_per_variant int not null default 120 check (min_invites_per_variant between 20 and 5000),
  status         text not null default 'draft' check (status in ('draft','washout','running','ready','concluded','abandoned')),
  started_at     timestamptz,
  washout_until  timestamptz,
  concluded_at   timestamptz,
  result         jsonb,
  notes          jsonb not null default '[]',        -- contamination warnings etc.
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now()
);
create index if not exists outreach_profile_experiments_ws_idx on outreach_profile_experiments(workspace_id, status);

-- -----------------------------------------------------------------------------
-- Snapshots + changes (PRD §6). Circular reference (change ↔ snapshot) is added after both exist.
-- -----------------------------------------------------------------------------
create table if not exists outreach_profile_snapshots (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references outreach_workspaces(id) on delete cascade,
  sender_id        uuid not null references outreach_senders(id) on delete cascade,
  kind             text not null check (kind in ('baseline','pre_change','post_change','drift_check')),
  sections         text[] not null default '{}',
  fidelity         text not null check (fidelity in ('full','partial','written_only')),
  data             jsonb not null,
  unwritten_fields text[] not null default '{}',
  drift            jsonb,                             -- drift_check: {changed:[field…]} when the read differs from the previous snapshot
  captured_at      timestamptz not null default now(),
  captured_by      uuid references auth.users(id),
  action_id        uuid references outreach_actions(id) on delete set null
);
create index if not exists outreach_profile_snapshots_sender_idx on outreach_profile_snapshots(sender_id, captured_at desc);

create table if not exists outreach_profile_changes (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references outreach_workspaces(id) on delete cascade,
  sender_id         uuid not null references outreach_senders(id) on delete cascade,
  field_groups      outreach_profile_field_group_t[] not null,
  payload           jsonb not null,
  assets            jsonb not null default '{}',     -- {picture: storage path | picture_url: https…, cover_picture: …}
  source            text not null check (source in ('manual','template','experiment','ai_draft','rollback','mcp')),
  template_id       uuid references outreach_profile_templates(id) on delete set null,
  experiment_id     uuid references outreach_profile_experiments(id) on delete set null,
  bulk_run_id       uuid,
  reverts_change_id uuid references outreach_profile_changes(id) on delete set null,
  status            text not null default 'draft'
                    check (status in ('draft','awaiting_owner','approved','queued','applied','partially_applied','failed','cancelled','reverted')),
  mode              text check (mode in ('propose_only','direct')),
  pre_snapshot_id   uuid references outreach_profile_snapshots(id) on delete set null,
  post_snapshot_id  uuid references outreach_profile_snapshots(id) on delete set null,
  applied_fields    text[] not null default '{}',
  failed_fields     jsonb not null default '{}',
  action_id         uuid references outreach_actions(id) on delete set null,
  scheduled_for     timestamptz,
  requested_by      uuid references auth.users(id),
  requested_by_email citext,
  approved_by_email citext,
  approval_token_hash text unique,
  approval_expires_at timestamptz,
  revert_token_hash text unique,
  revert_expires_at timestamptz,
  owner_notified_at timestamptz,
  verify_after      timestamptz,
  verified_at       timestamptz,
  error_code        text,
  note              text,
  submitted_at      timestamptz,
  applied_at        timestamptz,
  reverted_at       timestamptz,
  cancelled_reason  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists outreach_profile_changes_sender_idx on outreach_profile_changes(sender_id, created_at desc);
create index if not exists outreach_profile_changes_ws_status_idx on outreach_profile_changes(workspace_id, status);
create index if not exists outreach_profile_changes_pending_idx on outreach_profile_changes(status) where status in ('awaiting_owner','queued','applied','partially_applied');
create index if not exists outreach_profile_changes_verify_idx on outreach_profile_changes(verify_after) where verified_at is null and verify_after is not null;

alter table outreach_profile_snapshots add column if not exists change_id uuid references outreach_profile_changes(id) on delete set null;

drop trigger if exists outreach_profile_changes_updated on outreach_profile_changes;
create trigger outreach_profile_changes_updated before update on outreach_profile_changes for each row execute function outreach_set_updated_at();
drop trigger if exists outreach_profile_templates_updated on outreach_profile_templates;
create trigger outreach_profile_templates_updated before update on outreach_profile_templates for each row execute function outreach_set_updated_at();

-- -----------------------------------------------------------------------------
-- Bulk runs (preview token pattern, PRD §8.2 / §10.3)
-- -----------------------------------------------------------------------------
create table if not exists outreach_profile_bulk_runs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  template_id   uuid references outreach_profile_templates(id) on delete set null,
  experiment_id uuid references outreach_profile_experiments(id) on delete set null,
  sender_ids    uuid[] not null,
  variables     jsonb not null default '{}',
  rows          jsonb not null,                     -- [{sender_id, name, payload, field_groups, ok, mode, causes}]
  eligible      int not null default 0,
  excluded      int not null default 0,
  status        text not null default 'preview' check (status in ('preview','committed','expired')),
  expires_at    timestamptz not null default now() + interval '30 minutes',
  committed_at  timestamptz,
  result        jsonb,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);
create index if not exists outreach_profile_bulk_runs_ws_idx on outreach_profile_bulk_runs(workspace_id, created_at desc);
alter table outreach_profile_changes drop constraint if exists outreach_profile_changes_bulk_run_fk;
alter table outreach_profile_changes add constraint outreach_profile_changes_bulk_run_fk foreign key (bulk_run_id) references outreach_profile_bulk_runs(id) on delete set null;

-- -----------------------------------------------------------------------------
-- QA (PRD §8.4)
-- -----------------------------------------------------------------------------
create table if not exists outreach_profile_qa (
  sender_id    uuid primary key references outreach_senders(id) on delete cascade,
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  score        smallint not null check (score between 0 and 100),
  checks       jsonb not null,                    -- [{code, severity, pass, detail, fix_hint}]
  snapshot_id  uuid references outreach_profile_snapshots(id) on delete set null,
  computed_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- RLS. Reads for the people who can see the sender; every write goes through a function or the service role.
-- -----------------------------------------------------------------------------
alter table outreach_profile_ceilings        enable row level security;
alter table outreach_profile_authority       enable row level security;
alter table outreach_profile_authority_links enable row level security;   -- no policies: service role only (hashes + owner emails)
alter table outreach_profile_templates       enable row level security;
alter table outreach_profile_experiments     enable row level security;
alter table outreach_profile_snapshots       enable row level security;
alter table outreach_profile_changes         enable row level security;
alter table outreach_profile_bulk_runs       enable row level security;
alter table outreach_profile_qa              enable row level security;

drop policy if exists profile_ceilings_select on outreach_profile_ceilings;
create policy profile_ceilings_select on outreach_profile_ceilings for select to authenticated using (true);

select outreach__policy('outreach_profile_authority','pauth_select','select',
  'outreach_role_in(workspace_id) in (''owner'',''manager'') or exists (select 1 from outreach_senders s where s.id = sender_id and s.owner_user_id = auth.uid())');
select outreach__policy('outreach_profile_templates','ptpl_select','select','outreach_role_in(workspace_id) in (''owner'',''manager'',''member'') and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_profile_experiments','pexp_select','select','outreach_role_in(workspace_id) in (''owner'',''manager'',''member'')');
select outreach__policy('outreach_profile_snapshots','psnap_select','select',
  'outreach_role_in(workspace_id) in (''owner'',''manager'',''member'') and exists (select 1 from outreach_senders s where s.id = sender_id and outreach_client_visible(s.workspace_id, s.client_id))');
select outreach__policy('outreach_profile_changes','pchg_select','select',
  'outreach_role_in(workspace_id) in (''owner'',''manager'',''member'') and exists (select 1 from outreach_senders s where s.id = sender_id and outreach_client_visible(s.workspace_id, s.client_id))');
select outreach__policy('outreach_profile_bulk_runs','pbulk_select','select','outreach_role_in(workspace_id) in (''owner'',''manager'') or created_by = auth.uid()');
select outreach__policy('outreach_profile_qa','pqa_select','select',
  'outreach_role_in(workspace_id) in (''owner'',''manager'',''member'') and exists (select 1 from outreach_senders s where s.id = sender_id and outreach_client_visible(s.workspace_id, s.client_id))');

-- -----------------------------------------------------------------------------
-- Storage: uploaded profile / cover images. Path: <workspace_id>/<sender_id>/<uuid>.<ext>. Kept after apply so a rollback
-- can restore the exact original (PRD §7.2: "full if we uploaded it").
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('outreach-profile-assets','outreach-profile-assets', false, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists outreach_profile_assets_upload on storage.objects;
create policy outreach_profile_assets_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'outreach-profile-assets'
    and (storage.foldername(name))[1] in (select id::text from outreach_workspaces where id in (select outreach_workspace_ids()))
    and outreach_role_in(((storage.foldername(name))[1])::uuid) in ('owner','manager','member'));
drop policy if exists outreach_profile_assets_read on storage.objects;
create policy outreach_profile_assets_read on storage.objects for select to authenticated
  using (bucket_id = 'outreach-profile-assets'
    and (storage.foldername(name))[1] in (select id::text from outreach_workspaces where id in (select outreach_workspace_ids())));
