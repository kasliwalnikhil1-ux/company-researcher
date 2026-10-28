-- =============================================================================
-- Sales CRM — 006: prospect-research runs (what the research skill found and did)
-- Idempotent. Apply with the Supabase MCP apply_migration (or bash scripts/outreach-sql.sh migrations/crm/006_research.sql)
--
-- The prospect-research skill (claude.ai) researches the outside people on upcoming meetings, writes company /
-- contact profiles (`about`) and books the meetings. Two things it could not do before this migration:
--   1. remember what an earlier run already decided — a free-mail address it could not tie to anyone, a brand
--      inbox, a work email whose profile is still unconfirmed — so every run researched them again from scratch;
--   2. keep the "what changed" table it reports anywhere the team can read it later.
-- So: one row per run (crm_research_runs) and one row per record the run reported (crm_research_items) with a fixed
-- vocabulary; `crm_research_lookup` answers "what do we already know about these emails / domains?" in one call
-- BEFORE any research (CRM contact + company + the last research row + a skip/run suggestion), and
-- `crm_research_save` stores the report. The Calendar screen shows the rows (Research tab + inside an event).
--
-- Vocabulary (checked by the database; the UI and the skill use the same words):
--   kind      company | contact | meeting
--   verdict   what the research established about the identity (null for meetings)
--             confirmed     the person/company was identified with evidence (a page shows the email, the profile
--                           matches the company, the company's own website)
--             work_email    the email proves the company; the person's profile could not be confirmed
--             unconfirmed   nothing ties the email to a page or a company (name-only matches do not count)
--             shared_inbox  a brand / team inbox, not a person (info@, a gmail listed as the site's contact)
--             filtered      internal / personal — left out before research
--   action    what the run did to the CRM record
--             created | updated | skipped (existed, nothing to change) | not_added (nothing written)
--             for meetings the app shows these as Booked | Moved | Already on file | Not booked
--   needs_review  true when a human should look (unconfirmed person, work email with an unconfirmed profile,
--             near-duplicate merged, a placeholder meeting time); review_reason says why, best_match_url is the
--             closest profile found
--   researched false when the row was carried forward from an earlier run without new research
-- =============================================================================

create table if not exists crm_research_runs (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid references crm_members(user_id),
  created_at  timestamptz not null default now(),
  source      text,                                   -- one line: what was pasted / which meetings ("3 emails", "today's meetings")
  note        text,                                   -- the report's closing line (counts, what could not run)
  counts      jsonb not null default '{}'::jsonb      -- {created, updated, skipped, not_added, needs_review, meetings}
);

create table if not exists crm_research_items (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references crm_research_runs(id) on delete cascade,
  kind            text not null check (kind in ('company','contact','meeting')),
  label           text not null,                      -- "HiSO (hiso.ca)", "Maria Matar", "Monday review"
  email           text,                               -- the contact's email (lowercase) — how later runs find the row
  domain          text,                               -- the company's domain (lowercase, no www)
  company_id      uuid references crm_companies(id) on delete set null,
  contact_id      uuid references crm_contacts(id) on delete set null,
  meeting_id      uuid references crm_meetings(id) on delete set null,
  verdict         text check (verdict is null or verdict in ('confirmed','work_email','unconfirmed','shared_inbox','filtered')),
  action          text not null check (action in ('created','updated','skipped','not_added')),
  needs_review    boolean not null default false,
  researched      boolean not null default true,
  detail          text,                               -- "What changed", plain words
  review_reason   text,
  best_match_url  text,
  created_at      timestamptz not null default now()
);
create index if not exists crm_research_items_run_idx on crm_research_items (run_id);
create index if not exists crm_research_items_email_idx on crm_research_items (lower(email)) where email is not null;
create index if not exists crm_research_items_domain_idx on crm_research_items (domain) where domain is not null;
create index if not exists crm_research_items_meeting_idx on crm_research_items (meeting_id) where meeting_id is not null;
create index if not exists crm_research_items_created_idx on crm_research_items (created_at desc);

-- every stored email is lowercase + trimmed (migrations/normalize_email_columns.sql)
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'normalize_email_columns') then
    execute 'drop trigger if exists a0_normalize_emails on crm_research_items';
    execute 'create trigger a0_normalize_emails before insert or update on crm_research_items for each row execute function public.normalize_email_columns(''email'')';
  end if;
end $$;

alter table crm_research_runs enable row level security;
drop policy if exists crm_member_all on crm_research_runs;
create policy crm_member_all on crm_research_runs for all to authenticated using (crm_is_member()) with check (crm_is_member());
grant select, insert, update, delete on crm_research_runs to authenticated;

alter table crm_research_items enable row level security;
drop policy if exists crm_member_all on crm_research_items;
create policy crm_member_all on crm_research_items for all to authenticated using (crm_is_member()) with check (crm_is_member());
grant select, insert, update, delete on crm_research_items to authenticated;

-- Rows with their run + the CRM names they point at (the Calendar screen reads this)
create or replace view crm_research_items_v with (security_invoker = true) as
select i.*,
       r.created_at as run_at, r.created_by as run_by, m.display_name as run_by_name, r.source as run_source, r.note as run_note,
       c.name as company_name, c.domain as company_domain, ct.name as contact_name
from crm_research_items i
join crm_research_runs r on r.id = i.run_id
left join crm_members m on m.user_id = r.created_by
left join crm_companies c on c.id = i.company_id
left join crm_contacts ct on ct.id = i.contact_id;
grant select on crm_research_items_v to authenticated;

-- ---------------------------------------------------------------------------
-- crm_research_lookup: everything already known about a set of emails / domains, in one call.
-- The skill runs this BEFORE any research. Per email: the CRM contact (with its company and how complete its
-- profile is), the last research row for that email, and a suggestion — skip | run — with the reason.
-- Per domain: the CRM company, its profile state, the last research row, and the same suggestion.
-- Suggestion rules (the skill may override on "refresh"):
--   contact with a full profile (about.summary)                      → skip
--   last row within 30 days with verdict unconfirmed | shared_inbox   → skip (carry the row forward)
--   last row within 30 days with verdict work_email (profile unconfirmed) → skip (carry forward; still needs review)
--   company with description + industry                              → skip
--   anything else                                                    → run
-- ---------------------------------------------------------------------------
create or replace function crm_research_lookup(p_emails text[] default null, p_domains text[] default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out_emails jsonb := '[]'::jsonb; out_domains jsonb := '[]'::jsonb; e text; d text; ct record; co record; last record;
        profile text; suggestion text; why text; extra_domains text[] := '{}';
begin
  perform crm_require_member();

  foreach e in array coalesce(p_emails, '{}'::text[]) loop
    e := lower(trim(e));
    continue when e = '';
    select ct2.id, ct2.name, ct2.role, ct2.about, ct2.company_id, c.name as company_name, c.domain as company_domain, c.about as company_about
      into ct from crm_contacts ct2 join crm_companies c on c.id = ct2.company_id where lower(ct2.email) = e limit 1;
    select i.verdict, i.action, i.needs_review, i.detail, i.review_reason, i.best_match_url, i.label, r.created_at as run_at
      into last from crm_research_items i join crm_research_runs r on r.id = i.run_id where lower(i.email) = e and i.kind = 'contact' order by r.created_at desc limit 1;
    profile := case when ct.id is null then null when ct.about->>'summary' is not null then 'full' when ct.about is not null then 'partial' else 'none' end;
    if ct.id is not null and profile = 'full' then
      suggestion := 'skip'; why := 'contact already has a full profile in the CRM';
    elsif last.run_at is not null and last.run_at > now() - interval '30 days' and last.verdict in ('unconfirmed','shared_inbox','work_email') then
      suggestion := 'skip'; why := format('researched on %s, verdict %s — carry that row forward unless she says refresh', to_char(last.run_at, 'DD Mon YYYY'), last.verdict);
    else
      suggestion := 'run'; why := case when ct.id is null then 'not in the CRM' when profile = 'partial' then 'contact exists but the profile has no summary' else 'contact exists without a profile' end;
    end if;
    if ct.company_domain is not null then extra_domains := extra_domains || ct.company_domain; end if;
    out_emails := out_emails || jsonb_build_object(
      'email', e,
      'contact', case when ct.id is null then null else jsonb_build_object('contact_id', ct.id, 'name', ct.name, 'role', ct.role, 'profile', profile, 'summary', ct.about->>'summary',
                                                                        'company_id', ct.company_id, 'company', ct.company_name, 'company_domain', ct.company_domain,
                                                                        'company_profile', case when ct.company_about->>'description' is not null and ct.company_about->>'company_industry' is not null then 'full' when ct.company_about is not null then 'partial' else 'none' end) end,
      'last_research', case when last.run_at is null then null else jsonb_build_object('run_at', last.run_at, 'label', last.label, 'verdict', last.verdict, 'action', last.action, 'needs_review', last.needs_review, 'detail', last.detail, 'review_reason', last.review_reason, 'best_match_url', last.best_match_url) end,
      'suggestion', suggestion, 'why', why);
  end loop;

  foreach d in array (coalesce(p_domains, '{}'::text[]) || extra_domains) loop
    d := lower(trim(d)); d := regexp_replace(d, '^(https?://)?(www\.)?', ''); d := split_part(d, '/', 1);
    continue when d = '' or exists (select 1 from jsonb_array_elements(out_domains) x where x->>'domain' = d);
    select c.id, c.name, c.about, c.notes into co from crm_companies c where c.domain = d limit 1;
    select i.verdict, i.action, i.needs_review, i.detail, i.review_reason, i.label, r.created_at as run_at
      into last from crm_research_items i join crm_research_runs r on r.id = i.run_id where i.domain = d and i.kind = 'company' order by r.created_at desc limit 1;
    profile := case when co.id is null then null when co.about->>'description' is not null and co.about->>'company_industry' is not null then 'full' when co.about is not null then 'partial' else 'none' end;
    if co.id is not null and profile = 'full' then suggestion := 'skip'; why := 'company already has a full profile in the CRM';
    else suggestion := 'run'; why := case when co.id is null then 'not in the CRM' else 'company exists but the profile is incomplete' end; end if;
    out_domains := out_domains || jsonb_build_object(
      'domain', d,
      'company', case when co.id is null then null else jsonb_build_object('company_id', co.id, 'name', co.name, 'profile', profile, 'description', co.about->>'description', 'industry', co.about->>'company_industry', 'has_notes', co.notes is not null,
                                                                        'contacts', (select coalesce(jsonb_agg(jsonb_build_object('contact_id', x.id, 'name', x.name, 'email', x.email, 'role', x.role, 'profile', case when x.about->>'summary' is not null then 'full' when x.about is not null then 'partial' else 'none' end) order by x.is_primary desc, x.created_at), '[]') from crm_contacts x where x.company_id = co.id)) end,
      'last_research', case when last.run_at is null then null else jsonb_build_object('run_at', last.run_at, 'label', last.label, 'verdict', last.verdict, 'action', last.action, 'needs_review', last.needs_review, 'detail', last.detail, 'review_reason', last.review_reason) end,
      'suggestion', suggestion, 'why', why);
  end loop;

  return jsonb_build_object('emails', out_emails, 'domains', out_domains,
    'rules', 'skip = reuse what is here (full profile, or a verdict from the last 30 days); run = research. "refresh" from the user overrides a skip. A contact found by a free-mail address already ties that address to its company — do not research the company again when its profile is full.');
end $$;

-- ---------------------------------------------------------------------------
-- crm_research_save: store one run + its report rows. company_id / contact_id are resolved from domain / email when
-- not given. counts are computed from the rows unless passed. Returns {run_id, items, needs_review, counts}.
-- ---------------------------------------------------------------------------
create or replace function crm_research_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare rid uuid; it jsonb; n int := 0; v_kind text; v_action text; v_verdict text; v_email text; v_domain text;
        v_company uuid; v_contact uuid; v_meeting uuid; v_counts jsonb;
begin
  perform crm_require_member();
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'E_PAYLOAD_INVALID: items (array) is required'; end if;
  insert into crm_research_runs(created_by, source, note) values (auth.uid(), nullif(trim(coalesce(p->>'source', '')), ''), nullif(trim(coalesce(p->>'note', '')), '')) returning id into rid;
  for it in select * from jsonb_array_elements(p->'items') loop
    v_kind := lower(coalesce(it->>'kind', 'contact'));
    v_action := lower(coalesce(it->>'action', ''));
    v_verdict := nullif(lower(coalesce(it->>'verdict', '')), '');
    if v_kind not in ('company','contact','meeting') then raise exception 'E_PAYLOAD_INVALID: kind must be company | contact | meeting (got %)', v_kind; end if;
    if v_action not in ('created','updated','skipped','not_added') then raise exception 'E_PAYLOAD_INVALID: action must be created | updated | skipped | not_added (got "%" on "%")', v_action, it->>'label'; end if;
    if v_verdict is not null and v_verdict not in ('confirmed','work_email','unconfirmed','shared_inbox','filtered') then raise exception 'E_PAYLOAD_INVALID: verdict must be confirmed | work_email | unconfirmed | shared_inbox | filtered (got "%" on "%")', v_verdict, it->>'label'; end if;
    if nullif(trim(coalesce(it->>'label', '')), '') is null then raise exception 'E_PAYLOAD_INVALID: every item needs a label'; end if;
    v_email := nullif(lower(trim(coalesce(it->>'email', ''))), '');
    v_domain := nullif(lower(trim(coalesce(it->>'domain', ''))), '');
    if v_domain is not null then v_domain := split_part(regexp_replace(v_domain, '^(https?://)?(www\.)?', ''), '/', 1); end if;
    v_company := case when it->>'company_id' is not null then (it->>'company_id')::uuid else null end;
    v_contact := case when it->>'contact_id' is not null then (it->>'contact_id')::uuid else null end;
    v_meeting := case when it->>'meeting_id' is not null then (it->>'meeting_id')::uuid else null end;
    if v_contact is null and v_email is not null then select id into v_contact from crm_contacts where lower(email) = v_email limit 1; end if;
    if v_company is null and v_contact is not null then select company_id into v_company from crm_contacts where id = v_contact; end if;
    if v_company is null and v_domain is not null then select id into v_company from crm_companies where domain = v_domain limit 1; end if;
    if v_company is null and v_meeting is not null then select d.company_id into v_company from crm_meetings mt join crm_deals d on d.id = mt.deal_id where mt.id = v_meeting; end if;
    if v_domain is null and v_company is not null then select domain into v_domain from crm_companies where id = v_company; end if;
    insert into crm_research_items(run_id, kind, label, email, domain, company_id, contact_id, meeting_id, verdict, action, needs_review, researched, detail, review_reason, best_match_url)
    values (rid, v_kind, trim(it->>'label'), v_email, v_domain, v_company, v_contact, v_meeting, v_verdict, v_action,
            coalesce((it->>'needs_review')::boolean, false), coalesce((it->>'researched')::boolean, true),
            nullif(trim(coalesce(it->>'detail', '')), ''), nullif(trim(coalesce(it->>'review_reason', '')), ''), nullif(trim(coalesce(it->>'best_match_url', '')), ''));
    n := n + 1;
  end loop;
  select jsonb_build_object(
      'created', count(*) filter (where action = 'created' and kind <> 'meeting'),
      'updated', count(*) filter (where action = 'updated' and kind <> 'meeting'),
      'skipped', count(*) filter (where action = 'skipped' and kind <> 'meeting'),
      'not_added', count(*) filter (where action = 'not_added' and kind <> 'meeting'),
      'needs_review', count(*) filter (where needs_review),
      'meetings_booked', count(*) filter (where kind = 'meeting' and action = 'created'),
      'meetings_moved', count(*) filter (where kind = 'meeting' and action = 'updated'))
    into v_counts from crm_research_items where run_id = rid;
  if jsonb_typeof(p->'counts') = 'object' then v_counts := v_counts || (p->'counts'); end if;
  update crm_research_runs set counts = v_counts where id = rid;
  return jsonb_build_object('run_id', rid, 'items', n, 'needs_review', (v_counts->>'needs_review')::int, 'counts', v_counts, 'calendar', '/crm/calendar?view=research');
end $$;

-- Recent runs with their rows (connector: research_runs; the app reads the view directly)
create or replace function crm_research_runs_list(p_limit int default 10, p_needs_review boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_require_member();
  return (select coalesce(jsonb_agg(jsonb_build_object('run_id', r.id, 'at', r.created_at, 'by', m.display_name, 'source', r.source, 'note', r.note, 'counts', r.counts,
            'items', (select coalesce(jsonb_agg(jsonb_build_object('kind', i.kind, 'label', i.label, 'email', i.email, 'domain', i.domain, 'verdict', i.verdict, 'action', i.action, 'needs_review', i.needs_review, 'researched', i.researched,
                                                                   'detail', i.detail, 'review_reason', i.review_reason, 'best_match_url', i.best_match_url, 'company_id', i.company_id, 'contact_id', i.contact_id, 'meeting_id', i.meeting_id)
                                                order by i.needs_review desc, i.kind, i.created_at), '[]')
                      from crm_research_items i where i.run_id = r.id and (not p_needs_review or i.needs_review))) order by r.created_at desc), '[]')
          from (select * from crm_research_runs r0 where not p_needs_review or exists (select 1 from crm_research_items i0 where i0.run_id = r0.id and i0.needs_review) order by r0.created_at desc limit coalesce(p_limit, 10)) r
          left join crm_members m on m.user_id = r.created_by);
end $$;

-- ---------------------------------------------------------------------------
-- Grants (same loop as 002): RPCs for signed-in users only; the guards are inside
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'crm\_research\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';
