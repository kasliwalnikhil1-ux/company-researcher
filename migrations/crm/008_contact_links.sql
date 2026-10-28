-- 008: contact links — canonical LinkedIn URLs + the links on the Research view.
--
-- 1. Every LinkedIn URL is stored in ONE form: https://www.linkedin.com/<path>. Regional hosts (ae.linkedin.com,
--    in.linkedin.com, uk.linkedin.com…) are the same profile and broke outreach matching and opening; query strings,
--    fragments and trailing slashes are dropped. crm_contacts.linkedin_url, every url inside crm_contacts.about->'links'
--    and crm_research_items.best_match_url are normalised by trigger (so the connector's upsert_contact / save_research_report
--    and the app's forms all go through it) and backfilled once here. The app mirrors the rule in canonicalLinkedInUrl()
--    (lib/utils.ts) for the links it opens.
-- 2. crm_research_items_v carries the linked contact's linkedin_url + about.links (contact_linkedin_url, contact_links)
--    so Calendar → Research shows the same clickable links as the company page.
-- Idempotent.

-- ---------------------------------------------------------------- canonical LinkedIn URL
create or replace function crm_linkedin_url(u text) returns text
language sql immutable as $$
  select case
    when u is null then null
    when btrim(u) = '' then null
    when btrim(u) ~* '^(https?://)?([a-z]{2,3}\.)?(www\.)?linkedin\.com/' then
      'https://www.linkedin.com/' || rtrim(split_part(split_part(regexp_replace(btrim(u), '^(https?://)?([a-z]{2,3}\.)?(www\.)?linkedin\.com/', '', 'i'), '?', 1), '#', 1), '/')
    else btrim(u)
  end
$$;
comment on function crm_linkedin_url(text) is 'The one stored form of a LinkedIn URL: https://www.linkedin.com/<path> (regional hosts → www, no query/fragment/trailing slash). Non-LinkedIn text comes back trimmed.';

-- about.links = [{url, label}] (or bare URL strings): normalise each url the same way; anything else is left alone.
create or replace function crm_normalize_links(a jsonb) returns jsonb
language sql immutable as $$
  select case
    when a is null or coalesce(jsonb_typeof(a->'links'), '') <> 'array' then a
    else jsonb_set(a, '{links}', (
      select coalesce(jsonb_agg(
        case
          when jsonb_typeof(l) = 'object' and l ? 'url' and jsonb_typeof(l->'url') = 'string' then jsonb_set(l, '{url}', to_jsonb(crm_linkedin_url(l->>'url')))
          when jsonb_typeof(l) = 'string' then to_jsonb(crm_linkedin_url(l #>> '{}'))
          else l
        end), '[]'::jsonb)
      from jsonb_array_elements(a->'links') l))
  end
$$;

create or replace function crm_contacts_normalize_links() returns trigger
language plpgsql as $$
begin
  new.linkedin_url := crm_linkedin_url(new.linkedin_url);
  new.about := crm_normalize_links(new.about);
  return new;
end $$;
drop trigger if exists a1_normalize_links on crm_contacts;
create trigger a1_normalize_links before insert or update of linkedin_url, about on crm_contacts
  for each row execute function crm_contacts_normalize_links();

create or replace function crm_research_items_normalize_links() returns trigger
language plpgsql as $$
begin
  new.best_match_url := crm_linkedin_url(new.best_match_url);
  return new;
end $$;
drop trigger if exists a1_normalize_links on crm_research_items;
create trigger a1_normalize_links before insert or update of best_match_url on crm_research_items
  for each row execute function crm_research_items_normalize_links();

-- one-time backfill of what is already stored
update crm_contacts set linkedin_url = crm_linkedin_url(linkedin_url), about = crm_normalize_links(about)
 where linkedin_url is distinct from crm_linkedin_url(linkedin_url) or about is distinct from crm_normalize_links(about);
update crm_research_items set best_match_url = crm_linkedin_url(best_match_url)
 where best_match_url is distinct from crm_linkedin_url(best_match_url);

-- ---------------------------------------------------------------- research view: + the contact's links
create or replace view crm_research_items_v with (security_invoker = true) as
select i.*,
       r.created_at as run_at, r.created_by as run_by, m.display_name as run_by_name, r.source as run_source, r.note as run_note,
       c.name as company_name, c.domain as company_domain, ct.name as contact_name,
       ct.linkedin_url as contact_linkedin_url, ct.about->'links' as contact_links
from crm_research_items i
join crm_research_runs r on r.id = i.run_id
left join crm_members m on m.user_id = r.created_by
left join crm_companies c on c.id = i.company_id
left join crm_contacts ct on ct.id = i.contact_id;
grant select on crm_research_items_v to authenticated;
