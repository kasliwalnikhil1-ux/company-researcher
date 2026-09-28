-- Fix "canceling statement due to statement timeout" on /investors.
--
-- The previous LANGUAGE sql version built every matching investor row (wide
-- text/jsonb columns, a people-count subquery per firm and a firm lookup per
-- person), sorted all of them with row_number(), and only then cut to the
-- 10-50 rows of the page. That read ~160 MB (heap + TOAST) per page load and
-- spilled the sort to disk; with a cold cache it ran past the 8s
-- authenticated statement_timeout.
--
-- This version:
--   1. picks the page's ids first, touching only narrow columns, ordered by
--      (name, id) with OFFSET/LIMIT applied right there;
--   2. loads wide columns, the display affiliation and the people count for
--      those ids only.
-- It is plpgsql with plan_cache_mode = force_custom_plan so every call is
-- planned with the real parameter values: "p_x is null or ..." branches fold
-- away and the planner can walk idx_investors_type_name in name order and
-- stop at the page. (A LANGUAGE sql function is planned without parameter
-- values, so none of those predicates could ever use an index.)
--
-- Signature, result columns, ordering, paging/plan caps and personalization
-- gating are unchanged, so CREATE OR REPLACE is enough (grants are kept).
-- Applied to ktwqkvjuzsunssudqnrt on 2026-09-28.

CREATE INDEX IF NOT EXISTS idx_investors_type_name ON public.investors USING btree (type, name, id);

CREATE OR REPLACE FUNCTION public.search_investors(p_investor_id uuid DEFAULT NULL::uuid, p_type text DEFAULT NULL::text, p_query text DEFAULT NULL::text, p_active boolean DEFAULT NULL::boolean, p_role text[] DEFAULT NULL::text[], p_tier text[] DEFAULT NULL::text[], p_hq_state text DEFAULT NULL::text, p_hq_country text DEFAULT NULL::text, p_investor_type text[] DEFAULT NULL::text[], p_fund_size_min numeric DEFAULT NULL::numeric, p_fund_size_max numeric DEFAULT NULL::numeric, p_check_min numeric DEFAULT NULL::numeric, p_check_max numeric DEFAULT NULL::numeric, p_stages text[] DEFAULT NULL::text[], p_industries text[] DEFAULT NULL::text[], p_geographies text[] DEFAULT NULL::text[], p_leads_round boolean DEFAULT NULL::boolean, p_domains text[] DEFAULT NULL::text[], p_linkedin_urls text[] DEFAULT NULL::text[], p_exclude_domains text[] DEFAULT NULL::text[], p_exclude_linkedin_urls text[] DEFAULT NULL::text[], p_owner text[] DEFAULT NULL::text[], p_set text[] DEFAULT NULL::text[], p_reviewed_stage text[] DEFAULT NULL::text[], p_investor_fit boolean[] DEFAULT NULL::boolean[], p_mode text DEFAULT 'global'::text, p_limit integer DEFAULT NULL::integer, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, name text, type text, active boolean, role text, tier text, hq_state text, hq_country text, investor_type text[], fund_size_usd numeric, check_size_min_usd numeric, check_size_max_usd numeric, investment_stages text[], investment_industries text[], investment_geographies text[], investment_thesis text, notable_investments text[], coinvestors jsonb, work_experience_orgs jsonb, education_orgs jsonb, leads_round boolean, has_personalization boolean, set_name text, owner text, notes jsonb, stage text, ai_metadata jsonb, associated_firm_id uuid, associated_firm_name text, associated_people_count integer, domain text, linkedin_url text, twitter_url text, email text, email_verified boolean, phone text, apply_url text, links jsonb, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
declare
  v_uid  uuid := auth.uid();
  v_plan text;
  v_lim  integer;
  v_off  integer;
begin
  -- Treat missing row OR null plan as 'free'
  select coalesce(us.plan, 'free') into v_plan
  from public.user_settings us
  where us.id = v_uid;
  v_plan := coalesce(v_plan, 'free');

  -- Free plan: first page only, 10 rows. Paid global browse: max 10 per page.
  if v_plan = 'free' and coalesce(p_offset, 0) <> 0 then
    return;
  end if;

  v_lim := case
    when v_plan = 'free' then 10
    when p_mode = 'global' and p_investor_id is null then least(coalesce(p_limit, 10), 10)
    else coalesce(p_limit, 10)
  end;
  v_off := case when v_plan = 'free' then 0 else coalesce(p_offset, 0) end;

  return query
  with
  -- p_query split on commas into non-empty trimmed terms; a row matches if ANY term matches
  query_terms as (
    select btrim(t.term) as term
    from unnest(string_to_array(coalesce(p_query, ''), ',')) as t(term)
    where btrim(t.term) <> ''
  ),
  matching_firms as (
    select inv.id
    from public.investors inv
    where inv.type = 'firm'
      and exists (
        select 1
        from query_terms qt
        where inv.name ilike '%' || qt.term || '%'
           or inv.domain ilike '%' || qt.term || '%'
      )
  ),
  -- Step 1: the page's ids. Narrow columns only; sort + OFFSET/LIMIT here.
  page as (
    select i.id, i.name
    from public.investors i
    left join public.investor_personalization ip
      on ip.investor_id = i.id
     and ip.user_id = v_uid
    where
      (
        p_investor_id is null
        or (
          p_investor_id is not null
          and p_type is null
          and i.id = p_investor_id
        )
        or (
          p_investor_id is not null
          and p_type = 'person'
          and i.type = 'person'
          and exists (
            select 1
            from public.investor_affiliations ia
            where ia.firm_id = p_investor_id
              and ia.person_id = i.id
          )
        )
        or (
          p_investor_id is not null
          and p_type = 'firm'
          and i.type = 'firm'
          and i.id = p_investor_id
        )
      )

      and (
        (p_investor_id is not null and p_type is null)
        or (p_type is null or i.type = p_type)
      )

      and (
        p_mode = 'global'
        or (p_mode = 'reviewed' and ip.id is not null)
      )

      and (p_role is null or i.role = any(p_role))
      and (p_tier is null or i.tier = any(p_tier))
      and (p_active is null or coalesce(i.active, false) = p_active)
      and (p_hq_state is null or i.hq_state = p_hq_state)
      and (p_hq_country is null or i.hq_country = p_hq_country)

      and (p_investor_type is null or i.investor_type && p_investor_type)
      and (p_stages is null or i.investment_stages && p_stages)
      and (p_industries is null or i.investment_industries && p_industries)
      and (p_geographies is null or i.investment_geographies && p_geographies)

      and (p_fund_size_min is null or i.fund_size_usd >= p_fund_size_min)
      and (p_fund_size_max is null or i.fund_size_usd <= p_fund_size_max)

      and (p_check_min is null or i.check_size_min_usd >= p_check_min)
      and (p_check_max is null or i.check_size_max_usd <= p_check_max)

      and (p_leads_round is null or i.leads_round = p_leads_round)

      -- include lists
      and (p_domains is null or i.domain = any(p_domains))
      and (p_linkedin_urls is null or i.linkedin_url = any(p_linkedin_urls))

      -- exclude lists
      and (p_exclude_domains is null or i.domain is null or i.domain <> all(p_exclude_domains))
      and (p_exclude_linkedin_urls is null or i.linkedin_url is null or i.linkedin_url <> all(p_exclude_linkedin_urls))

      -- personalization filters
      and (p_owner is null or ip.owner = any(p_owner))
      and (p_set is null or ip.set_name = any(p_set))

      and (
        p_reviewed_stage is null
        or ip.stage = any(p_reviewed_stage)
        or ('Identified' = any(p_reviewed_stage) and ip.stage is null)
      )

      and (
        p_investor_fit is null
        or (
          (
            ip.ai_metadata ? 'investor_fit'
            and (ip.ai_metadata ->> 'investor_fit')::boolean = any(p_investor_fit)
          )
          or (
            ip.ai_metadata ->> 'investor_fit' is null
            and null = any(p_investor_fit)
          )
        )
      )

      -- query: any comma-separated term matches OR (people search + firm match ->
      -- affiliated people, checked over ALL affiliations, not just the display one)
      and (
        p_query is null
        or exists (
          select 1
          from query_terms qt
          where i.name ilike '%' || qt.term || '%'
             or i.domain ilike '%' || qt.term || '%'
             or i.linkedin_url ilike '%' || qt.term || '%'
        )
        or (
          p_type = 'person'
          and i.type = 'person'
          and exists (
            select 1
            from public.investor_affiliations ia
            where ia.person_id = i.id
              and ia.firm_id in (select mf.id from matching_firms mf)
          )
        )
      )
    order by i.name asc, i.id asc
    offset v_off
    limit v_lim
  )
  -- Step 2: wide columns + per-row lookups for the page rows only.
  select
    i.id,
    i.name,
    i.type,
    i.active,
    i.role,
    i.tier,
    i.hq_state,
    i.hq_country,
    i.investor_type,
    i.fund_size_usd,
    i.check_size_min_usd,
    i.check_size_max_usd,
    i.investment_stages,
    i.investment_industries,
    i.investment_geographies,
    i.investment_thesis,
    i.notable_investments,
    i.coinvestors::jsonb,  -- column is json; plpgsql won't coerce it like LANGUAGE sql did
    i.work_experience_orgs,
    i.education_orgs,
    i.leads_round,

    (ip.id is not null) as has_personalization,

    ip.set_name,
    ip.owner,
    ip.notes,
    ip.stage,
    ip.ai_metadata,

    case when i.type = 'person' then af.firm_id end as associated_firm_id,
    case when i.type = 'person' then af.firm_name end as associated_firm_name,

    case
      when i.type = 'firm' then (
        select count(*)::integer
        from public.investor_affiliations ia
        join public.investors p on p.id = ia.person_id
        where ia.firm_id = i.id
          and coalesce(p.active, false) = true
      )
    end as associated_people_count,

    -- private fields (only if personalized)
    case when ip.id is not null then i.domain end as domain,
    case when ip.id is not null then i.linkedin_url end as linkedin_url,
    case when ip.id is not null then i.twitter_url end as twitter_url,
    case when ip.id is not null then i.email end as email,
    i.email_verified,
    case when ip.id is not null then i.phone end as phone,
    case when ip.id is not null then i.apply_url end as apply_url,
    case when ip.id is not null then i.links end as links,

    i.updated_at

  from page pg
  join public.investors i on i.id = pg.id

  left join public.investor_personalization ip
    on ip.investor_id = i.id
   and ip.user_id = v_uid

  -- exactly one display affiliation per person: prefer the queried firm, then
  -- alphabetical. (person_id, firm_id) is unique so this is deterministic.
  left join lateral (
    select ia.firm_id, fx.name as firm_name
    from public.investor_affiliations ia
    join public.investors fx on fx.id = ia.firm_id
    where ia.person_id = i.id
    order by (ia.firm_id = p_investor_id) desc, fx.name asc, ia.firm_id asc
    limit 1
  ) af on i.type = 'person'

  order by pg.name asc, pg.id asc;
end;
$function$;
