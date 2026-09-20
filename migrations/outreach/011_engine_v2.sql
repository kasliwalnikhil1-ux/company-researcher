-- =============================================================================
-- Outreach Platform — 011 engine v2
--   item 1  reply stops the lead everywhere, clean exit, OOO resume, hold-for-review
--   item 4  originating step on every message (replied_to_action_id / is_first_reply)
--   item 6  version pinning: every graph read goes through outreach_enrollment_graph()
--   item 11 A/B: sticky variant assignment, ab_split node, variant-aware node stats
--   item 12 InMail speed guard (in the budget, so nothing can out-send it)
--   item 15 ai_route node   item 24 call_task / follow   item 25 voice note   item 26 find_email
-- Safety stays in the database: every new step consumes an existing (or new) budget row
-- through outreach_reserve_budget; nothing here can switch a cap off.
-- =============================================================================

alter table outreach_senders drop column if exists email_schedule;  -- mailboxes are sender rows: their own `schedule` IS the email schedule

alter table outreach_messages add column if not exists counted_interested boolean not null default false;

create table if not exists outreach_split_assignments (   -- sticky ab_split branch per enrollment (item 11 step 2)
  enrollment_id uuid not null references outreach_enrollments(id) on delete cascade,
  node_id       text not null,
  sequence_id   uuid not null references outreach_sequences(id) on delete cascade,
  branch        text not null,
  at            timestamptz not null default now(),
  primary key (enrollment_id, node_id)
);
create index if not exists outreach_split_assignments_seq_idx on outreach_split_assignments(sequence_id, node_id, branch);
alter table outreach_split_assignments enable row level security;
select outreach__policy('outreach_split_assignments','split_select','select','exists (select 1 from outreach_sequences s where s.id = sequence_id and s.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(s.workspace_id, s.client_id))');

-- -----------------------------------------------------------------------------
-- Node catalogue
-- -----------------------------------------------------------------------------
create or replace function outreach_node_action_type(p_type text) returns outreach_action_type_t
language sql immutable as $$
  select case p_type
    when 'visit_profile' then 'profile_view'::outreach_action_type_t
    when 'refresh_profile' then 'profile_view'
    when 'like_latest_post' then 'like'
    when 'comment_latest_post' then 'comment'
    when 'endorse_skills' then 'endorse'
    when 'follow_profile' then 'follow'
    when 'send_invite' then 'invite'
    when 'withdraw_invite' then 'withdraw'
    when 'send_message' then 'message'
    when 'send_voice_note' then 'message'      -- a voice note is a LinkedIn message: it spends the message budget
    when 'send_inmail' then 'inmail'
    when 'send_email' then 'email'
    when 'call_api' then 'call_api'
    when 'find_email' then 'find_email'
    else null end
$$;

create or replace function outreach_is_executable_node(p_type text) returns boolean
language sql immutable as $$
  select p_type in ('visit_profile','refresh_profile','like_latest_post','comment_latest_post','endorse_skills','follow_profile','send_invite',
                    'withdraw_invite','send_message','send_voice_note','send_inmail','send_email','call_api','find_email')
$$;

create or replace function outreach_node_types() returns text[]
language sql immutable as $$
  select array['start','end','visit_profile','refresh_profile','like_latest_post','comment_latest_post','endorse_skills','follow_profile','send_invite',
    'wait_connection','withdraw_invite','send_message','send_voice_note','send_inmail','send_email','delay','condition','rotate_sender',
    'change_sender','add_tag','remove_tag','change_list','change_stage','call_webhook','call_api','find_email','send_to_sequence',
    'manual_task','call_task','ai_draft_approval','ab_split','ai_route']
$$;

-- -----------------------------------------------------------------------------
-- The one way to read an enrollment's graph (item 6). Pinned → that version; else the live graph.
-- -----------------------------------------------------------------------------
create or replace function outreach_enrollment_graph(p_enrollment uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare g jsonb; ws uuid;
begin
  select e.workspace_id,
         coalesce((select v.graph from outreach_sequence_versions v where v.sequence_id = e.sequence_id and v.version = e.pinned_version), s.graph)
    into ws, g
    from outreach_enrollments e join outreach_sequences s on s.id = e.sequence_id where e.id = p_enrollment;
  if ws is null then return null; end if;
  if not outreach_is_service() then perform outreach_require(ws, 'client_viewer'); end if;
  if not outreach_client_visible(ws, (select sq_.client_id from outreach_enrollments en_ join outreach_sequences sq_ on sq_.id = en_.sequence_id where en_.id = p_enrollment)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  return g;
end $$;

-- -----------------------------------------------------------------------------
-- Spintax helpers (item 16). `{Hi|Hello|Hey}` — single braces with at least one pipe; never `{{var|fallback}}`.
-- Rendering lives in the two TS renderers (shared test file); SQL only needs the longest combination for limits.
-- -----------------------------------------------------------------------------
create or replace function outreach_spintax_info(p_text text) returns table(max_len int, combinations bigint)
language plpgsql immutable as $$
declare t text := coalesce(p_text, ''); m text[]; opts text[]; o text; longest text; guard int := 0; combos bigint := 1;
begin
  loop
    guard := guard + 1;
    exit when guard > 200;
    m := regexp_match(t, '(?<!\{)\{(?!\{)([^{}|]*(?:\|[^{}]*)+)\}(?!\})');
    exit when m is null;
    opts := string_to_array(m[1], '|');
    longest := '';
    foreach o in array opts loop if length(o) > length(longest) then longest := o; end if; end loop;
    combos := least(combos * array_length(opts, 1), 1000000000);
    t := replace(t, '{' || m[1] || '}', longest);   -- identical groups share a length, so replacing all is safe
  end loop;
  -- conditional blocks count at their full length (worst case): strip the tags only
  t := regexp_replace(t, '\{\{\s*[#/]if[^}]*\}\}', '', 'g');
  max_len := length(t); combinations := combos;
  return next;
end $$;

create or replace function outreach_template_max_len(p_text text) returns int
language sql immutable as $$ select max_len from outreach_spintax_info(p_text) $$;

-- -----------------------------------------------------------------------------
-- Sticky A/B assignment (item 11): hash(enrollment, node) → stable per lead, random across leads.
-- p_variants: [{id, weight}] (weight defaults to 1, ≤0 = off). Same function serves message variants and ab_split.
-- -----------------------------------------------------------------------------
create or replace function outreach_pick_variant(p_enrollment uuid, p_node_id text, p_variants jsonb) returns text
language plpgsql immutable as $$
declare total numeric := 0; v jsonb; w numeric; h numeric; acc numeric := 0;
begin
  if p_variants is null or jsonb_typeof(p_variants) <> 'array' or jsonb_array_length(p_variants) = 0 then return null; end if;
  for v in select * from jsonb_array_elements(p_variants) loop
    w := greatest(coalesce((v->>'weight')::numeric, 1), 0); total := total + w;
  end loop;
  if total <= 0 then return p_variants->0->>'id'; end if;
  h := (('x' || substr(md5(p_enrollment::text || '|' || coalesce(p_node_id,'')), 1, 8))::bit(32)::bigint % 100000) / 100000.0 * total;
  for v in select * from jsonb_array_elements(p_variants) loop
    w := greatest(coalesce((v->>'weight')::numeric, 1), 0);
    acc := acc + w;
    if h < acc then return v->>'id'; end if;
  end loop;
  return p_variants->(jsonb_array_length(p_variants) - 1)->>'id';
end $$;

-- Node config with the enrollment's variant merged over it (text/subject/html/note), plus variant_id.
create or replace function outreach_node_config_for(p_enrollment uuid, p_node jsonb) returns jsonb
language plpgsql immutable as $$
declare cfg jsonb := coalesce(p_node->'config', '{}'::jsonb); vid text; v jsonb;
begin
  if jsonb_typeof(cfg->'variants') = 'array' and jsonb_array_length(cfg->'variants') > 0 then
    vid := outreach_pick_variant(p_enrollment, p_node->>'id', cfg->'variants');
    select x into v from jsonb_array_elements(cfg->'variants') x where x->>'id' = vid limit 1;
    if v is not null then
      cfg := (cfg - 'variants') || jsonb_strip_nulls(jsonb_build_object('text', v->'text', 'note', v->'note', 'subject', v->'subject', 'html', v->'html'))
             || jsonb_build_object('variant_id', vid);
    end if;
  end if;
  return cfg - 'variants';
end $$;

-- -----------------------------------------------------------------------------
-- Structural + semantic validation (supersedes 002). p_strict=true adds activation-level checks.
-- -----------------------------------------------------------------------------
create or replace function outreach_validate_graph(p_graph jsonb, p_pool uuid[] default '{}', p_strict boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  errors jsonb := '[]'; warnings jsonb := '[]';
  nodes jsonb; k text; n jsonb; t text; nxt text; b record; v jsonb; texts jsonb; tx text; ids text[];
  has_free boolean := false; has_mailbox boolean := false;
  has_connect_path boolean := false; has_terminal boolean := false;
  note_limit int; visited text[] := '{}'; queue text[]; cur text; lim int; ml int;
begin
  if p_graph is null or jsonb_typeof(p_graph) <> 'object' then
    return jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('code','E_GRAPH_INVALID','message','graph must be an object')), 'warnings', '[]'::jsonb);
  end if;
  nodes := p_graph->'nodes';
  if nodes is null or jsonb_typeof(nodes) <> 'object' then
    errors := errors || jsonb_build_object('code','E_GRAPH_INVALID','message','graph.nodes missing');
    return jsonb_build_object('errors', errors, 'warnings', warnings);
  end if;
  if not (nodes ? coalesce(p_graph->>'start','')) then
    errors := errors || jsonb_build_object('code','E_GRAPH_INVALID','message','start node not found');
  end if;

  if array_length(p_pool,1) > 0 then
    select bool_or(not is_premium) filter (where provider = 'LINKEDIN'), bool_or(provider <> 'LINKEDIN')
      into has_free, has_mailbox from outreach_senders where id = any(p_pool);
  end if;
  note_limit := case when coalesce(has_free,false) then 200 else 300 end;

  for k, n in select * from jsonb_each(nodes) loop
    t := n->>'type';
    if t is null or not (t = any(outreach_node_types())) then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','unknown node type '||coalesce(t,'null'));
      continue;
    end if;
    if coalesce(n->>'id', k) <> k then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','node id mismatch');
    end if;
    nxt := n->>'next';
    if nxt is not null and not (nodes ? nxt) then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','next points to missing node '||nxt);
    end if;
    if n ? 'branches' and jsonb_typeof(n->'branches') = 'object' then
      for b in select * from jsonb_each_text(n->'branches') loop
        if b.value is not null and not (nodes ? b.value) then
          errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','branch '||b.key||' points to missing node');
        end if;
      end loop;
    end if;
    if t = 'end' or (nxt is null and not (n ? 'branches') and t <> 'start') or t = 'send_to_sequence' then has_terminal := true; end if;
    if t in ('send_invite','wait_connection','send_inmail') then has_connect_path := true; end if;

    -- every text the step can send: the base copy plus each variant (longest spintax combination is what counts)
    texts := '[]'::jsonb;
    if t in ('send_invite','send_message','send_inmail','send_email','comment_latest_post') then
      texts := texts || jsonb_build_array(jsonb_build_object('label','', 'text', coalesce(n->'config'->>'text', n->'config'->>'note', n->'config'->>'html',''), 'subject', coalesce(n->'config'->>'subject','')));
      if jsonb_typeof(n->'config'->'variants') = 'array' then
        ids := '{}';
        for v in select * from jsonb_array_elements(n->'config'->'variants') loop
          if coalesce(v->>'id','') = '' then
            errors := errors || jsonb_build_object('node_id', k, 'code','E_VARIANT_INVALID','message','every variant needs an id');
          elsif v->>'id' = any(ids) then
            errors := errors || jsonb_build_object('node_id', k, 'code','E_VARIANT_INVALID','message','duplicate variant id '||(v->>'id'));
          end if;
          ids := ids || coalesce(v->>'id','');
          if coalesce((v->>'weight')::numeric, 1) < 0 then
            errors := errors || jsonb_build_object('node_id', k, 'code','E_VARIANT_INVALID','message','variant weight cannot be negative');
          end if;
          texts := texts || jsonb_build_array(jsonb_build_object('label',' (variant '||coalesce(v->>'label', v->>'id','?')||')', 'text', coalesce(v->>'text', v->>'note', v->>'html',''), 'subject', coalesce(v->>'subject','')));
        end loop;
        if jsonb_array_length(n->'config'->'variants') = 1 then
          warnings := warnings || jsonb_build_object('node_id', k, 'code','W_SINGLE_VARIANT','message','an A/B test needs at least two variants');
        end if;
        if jsonb_array_length(n->'config'->'variants') > 5 then
          errors := errors || jsonb_build_object('node_id', k, 'code','E_VARIANT_INVALID','message','at most 5 variants per step');
        end if;
      end if;
      lim := case t when 'send_invite' then note_limit when 'send_message' then 8000 when 'comment_latest_post' then 1250 when 'send_inmail' then 1900 else null end;
      for v in select * from jsonb_array_elements(texts) loop
        tx := v->>'text';
        if jsonb_array_length(texts) > 1 and v->>'label' = '' and tx = '' then continue; end if;   -- variants replace an empty base copy
        ml := outreach_template_max_len(tx);
        if lim is not null and ml > lim then
          errors := errors || jsonb_build_object('node_id', k, 'code', case when t = 'send_invite' then 'E_NOTE_TOO_LONG' else 'E_PAYLOAD_INVALID' end,
            'message', case t when 'send_invite' then 'invite note' when 'send_message' then 'message' when 'comment_latest_post' then 'comment' else 'InMail body' end
                       || (v->>'label') || ' can reach ' || ml || ' characters (limit ' || lim || '); the longest spintax combination counts');
        end if;
        if t = 'send_inmail' and outreach_template_max_len(v->>'subject') > 200 then
          errors := errors || jsonb_build_object('node_id', k, 'code','E_PAYLOAD_INVALID','message','InMail subject'||(v->>'label')||' exceeds 200 characters');
        end if;
        if t = 'send_email' and p_strict and tx <> '' and position('unsubscribe_link' in tx) = 0 then
          warnings := warnings || jsonb_build_object('node_id', k, 'code','W_NO_UNSUBSCRIBE','message','email'||(v->>'label')||' has no {{unsubscribe_link}}');
        end if;
      end loop;
    end if;

    if t = 'condition' and not (n->'branches' ? 'true' and n->'branches' ? 'false') then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_BRANCH_MISSING','message','condition should define true and false branches');
    end if;
    if t = 'wait_connection' and not (n->'branches' ? 'connected') then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','wait_connection needs a connected branch');
    end if;
    if t = 'ab_split' then
      if jsonb_typeof(n->'config'->'branches') <> 'array' or jsonb_array_length(n->'config'->'branches') < 2 then
        errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','A/B split needs at least two weighted branches');
      else
        for v in select * from jsonb_array_elements(n->'config'->'branches') loop
          if not (coalesce(n->'branches','{}'::jsonb) ? coalesce(v->>'id','')) then
            errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','A/B branch '||coalesce(v->>'id','?')||' is not connected');
          end if;
        end loop;
      end if;
    end if;
    if t = 'ai_route' then
      if jsonb_typeof(n->'config'->'routes') <> 'array' or jsonb_array_length(n->'config'->'routes') < 1 then
        errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','AI routing needs at least one described branch');
      else
        for v in select * from jsonb_array_elements(n->'config'->'routes') loop
          if length(trim(coalesce(v->>'description',''))) < 3 then
            errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','describe AI branch '||coalesce(v->>'id','?')||' in plain language');
          end if;
        end loop;
      end if;
      if not (coalesce(n->'branches','{}'::jsonb) ? 'else') then
        errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','AI routing needs an "everything else" branch');
      end if;
    end if;
    if t = 'send_email' and p_strict and not has_mailbox and (n->'config'->>'mailbox_sender_id') is null
       and coalesce(jsonb_array_length(case when jsonb_typeof(n->'config'->'mailbox_pool') = 'array' then n->'config'->'mailbox_pool' else '[]'::jsonb end), 0) = 0 then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_NO_MAILBOX','message','email node requires a mailbox sender in the pool');
    end if;
    if t in ('send_invite','send_message','comment_latest_post','send_inmail') and (n->'config'->'ai') is not null and (n->'config'->'ai'->>'brief') is null then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_AI_BRIEF','message','AI drafting enabled without a brief');
    end if;
    if t = 'send_voice_note' and p_strict then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_VOICE_CLIP','message','each pool sender needs a recorded clip for this step; senders without one skip it');
    end if;
  end loop;

  if p_strict then
    if not has_terminal then
      errors := errors || jsonb_build_object('code','E_GRAPH_INVALID','message','no exit path (add an End node)');
    end if;
    if exists (select 1 from jsonb_each(nodes) x where x.value->>'type' in ('send_message','send_voice_note') and not coalesce((x.value->'config'->>'send_always')::boolean,false)) and not has_connect_path then
      errors := errors || jsonb_build_object('code','E_RELATION_REQUIRED','message','a message node needs an invite / wait_connection (or InMail) path before it');
    end if;
    queue := array[p_graph->>'start'];
    while array_length(queue,1) > 0 loop
      cur := queue[1]; queue := queue[2:];
      if cur is null or cur = any(visited) then continue; end if;
      visited := visited || cur;
      n := nodes->cur;
      if n->>'next' is not null then queue := queue || (n->>'next'); end if;
      if n ? 'branches' and jsonb_typeof(n->'branches') = 'object' then
        for b in select * from jsonb_each_text(n->'branches') loop queue := queue || b.value; end loop;
      end if;
    end loop;
    for k in select key from jsonb_each(nodes) loop
      if not (k = any(visited)) then
        warnings := warnings || jsonb_build_object('node_id', k, 'code','W_UNREACHABLE','message','node is not reachable from start');
      end if;
    end loop;
  end if;

  return jsonb_build_object('errors', errors, 'warnings', warnings);
end $$;

-- -----------------------------------------------------------------------------
-- Condition evaluation: enrichment fields + call outcome (items 13, 24)
-- -----------------------------------------------------------------------------
create or replace function outreach_eval_rule(p_rule jsonb, p_lead outreach_leads, p_lss outreach_lead_sender_state, p_sender outreach_senders)
returns boolean language plpgsql stable security definer set search_path = public, extensions as $$
declare f text; op text; v text; actual text; ok boolean; pr outreach_lead_profiles;
begin
  f := p_rule->>'field'; op := coalesce(p_rule->>'op','eq'); v := p_rule->>'value';
  if f like 'enrich.%' then select * into pr from outreach_lead_profiles where lead_id = p_lead.id; end if;
  if f = 'replied' then actual := coalesce(p_lss.replied,false)::text;
  elsif f = 'accepted' then actual := (coalesce(p_lss.relation,'none') = 'first')::text;
  elsif f = 'relation' then actual := coalesce(p_lss.relation,'none')::text;
  elsif f = 'email_bounced' then actual := coalesce(p_lss.email_bounced,false)::text;
  elsif f = 'has_email_work' then actual := (p_lead.email_work is not null)::text;
  elsif f = 'has_email_personal' then actual := (p_lead.email_personal is not null)::text;
  elsif f = 'has_phone' then actual := (p_lead.phone is not null)::text;
  elsif f = 'is_open_profile' then actual := coalesce(p_lead.is_open_profile,false)::text;
  elsif f = 'has_tag' then actual := exists(select 1 from outreach_lead_tags where lead_id = p_lead.id and tag_id::text = v)::text; v := 'true';
  elsif f = 'stage_is' then actual := (p_lead.stage_id::text = v)::text; v := 'true';
  elsif f = 'sender_is_premium' then actual := coalesce(p_sender.is_premium,false)::text;
  elsif f like 'custom.%' then actual := p_lead.custom->>substr(f,8);
  elsif f = 'company' then actual := p_lead.company;
  elsif f = 'title' then actual := p_lead.title;
  elsif f = 'headline' then actual := p_lead.headline;
  elsif f = 'location' then actual := p_lead.location;
  elsif f = 'call_outcome' then
    select t.result->>'outcome' into actual from outreach_tasks t where t.lead_id = p_lead.id and t.kind = 'call' and t.completed_at is not null order by t.completed_at desc limit 1;
  -- enrichment (item 13)
  elsif f = 'enrich.is_enriched' then actual := (pr.enriched_at is not null)::text;
  elsif f = 'enrich.months_in_role' then actual := case when pr.current_started_on is null then null else ((extract(year from age(now(), pr.current_started_on)) * 12 + extract(month from age(now(), pr.current_started_on)))::int)::text end;
  elsif f = 'enrich.past_company' then actual := (select string_agg(x->>'company', ' | ') from jsonb_array_elements(coalesce(pr.experience,'[]'::jsonb)) x where not coalesce((x->>'current')::boolean,false));
  elsif f = 'enrich.skill' then actual := array_to_string(pr.skills, ' | ');
  elsif f = 'enrich.posted_within_days' then actual := case when pr.last_posted_at is null then null else (extract(epoch from now() - pr.last_posted_at) / 86400)::int::text end;
    if op = 'eq' then op := 'lte'; end if;   -- "posted in the last N days"
  elsif f = 'enrich.follower_count' then actual := pr.follower_count::text;
  elsif f = 'enrich.connections_count' then actual := pr.connections_count::text;
  elsif f = 'enrich.language' then actual := coalesce(pr.profile_language, array_to_string(pr.languages, ' | '));
  elsif f = 'enrich.about' then actual := pr.about;
  elsif f = 'enrich.education' then actual := (select string_agg(x->>'school', ' | ') from jsonb_array_elements(coalesce(pr.education,'[]'::jsonb)) x);
  else actual := null; end if;

  if op in ('eq','is') then ok := coalesce(lower(actual) = lower(coalesce(v,'')), false);
  elsif op in ('neq','not','is_not') then ok := coalesce(lower(actual) <> lower(coalesce(v,'')), true);
  elsif op = 'contains' then ok := coalesce(position(lower(coalesce(v,'')) in lower(actual)) > 0, false);
  elsif op = 'not_contains' then ok := coalesce(position(lower(coalesce(v,'')) in lower(actual)) = 0, true);
  elsif op = 'exists' then ok := actual is not null and actual <> '';
  elsif op = 'not_exists' then ok := actual is null or actual = '';
  elsif op = 'gt' then ok := coalesce(actual::numeric > v::numeric, false);
  elsif op = 'lt' then ok := coalesce(actual::numeric < v::numeric, false);
  elsif op = 'gte' then ok := coalesce(actual::numeric >= v::numeric, false);
  elsif op = 'lte' then ok := coalesce(actual::numeric <= v::numeric, false);
  else ok := false; end if;
  return ok;
exception when others then return false;
end $$;

-- -----------------------------------------------------------------------------
-- Queue helper: stores the variant on the action row
-- -----------------------------------------------------------------------------
create or replace function outreach_queue_action(
  p_enrollment uuid, p_node_id text, p_type outreach_action_type_t, p_scheduled_for timestamptz,
  p_payload jsonb default '{}', p_sender uuid default null, p_lead uuid default null, p_import_job uuid default null, p_workspace uuid default null
) returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare e outreach_enrollments%rowtype; attempt_no int; key text; ws uuid; sid uuid; lid uuid; aid uuid; sched timestamptz;
begin
  if p_enrollment is not null then
    select * into e from outreach_enrollments where id = p_enrollment;
    if not found then raise exception 'E_ENROLLMENT_NOT_FOUND'; end if;
    ws := e.workspace_id; sid := coalesce(p_sender, e.sender_id); lid := e.lead_id;
  else
    ws := p_workspace; sid := p_sender; lid := p_lead;
  end if;
  if not outreach_is_service() then perform outreach_require(ws, 'member'); end if;
  select count(*) + 1 into attempt_no from outreach_actions
    where coalesce(enrollment_id::text, coalesce(import_job_id::text, sender_id::text)) = coalesce(p_enrollment::text, coalesce(p_import_job::text, sid::text))
      and coalesce(node_id,'') = coalesce(p_node_id,'') and action_type = p_type and coalesce(lead_id::text,'') = coalesce(lid::text,'')
      and coalesce((payload->>'prefetch')::boolean,false) = coalesce((p_payload->>'prefetch')::boolean,false)
      and coalesce((payload->>'subtask')::boolean,false) = coalesce((p_payload->>'subtask')::boolean,false);
  key := encode(digest(coalesce(p_enrollment::text, coalesce(p_import_job::text, sid::text)) || '|' || coalesce(p_node_id,'') || '|' || p_type::text || '|' || coalesce(lid::text,'') || '|' || coalesce(p_payload->>'prefetch','') || coalesce(p_payload->>'subtask','') || '|' || attempt_no::text, 'sha256'), 'hex');
  sched := p_scheduled_for;
  if extract(second from sched) = 0 and extract(minute from sched)::int in (0,30) then
    sched := sched + make_interval(secs => 1 + floor(random()*58));
  end if;
  insert into outreach_actions(workspace_id, enrollment_id, import_job_id, sender_id, lead_id, node_id, action_type, scheduled_for, idempotency_key, payload, variant_id)
  values (ws, p_enrollment, p_import_job, sid, lid, p_node_id, p_type, sched, key, coalesce(p_payload,'{}'), nullif(p_payload->>'variant_id',''))
  on conflict (idempotency_key) do nothing
  returning id into aid;
  return aid;
end $$;
revoke execute on function outreach_queue_action(uuid,text,outreach_action_type_t,timestamptz,jsonb,uuid,uuid,uuid,uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Enter a node and chain through passive nodes until a wait state / executable node / end.
-- -----------------------------------------------------------------------------
create or replace function outreach_enter_node(p_enrollment uuid, p_node_id text, p_not_before timestamptz default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  e outreach_enrollments%rowtype; seq outreach_sequences%rowtype; g jsonb; n jsonb; t text; nid text; guard int := 0;
  amount numeric; unit text; jit numeric; iv interval; rel outreach_relation_t; branch text; pool uuid[]; pos int; nxt_sender uuid;
  new_id uuid; target uuid; dec outreach_ai_route_decisions%rowtype;
begin
  select * into e from outreach_enrollments where id = p_enrollment for update;
  if not found then return; end if;
  if e.status not in ('active','waiting_connection','waiting_delay','waiting_task') then return; end if;
  select * into seq from outreach_sequences where id = e.sequence_id;
  g := coalesce((select v.graph from outreach_sequence_versions v where v.sequence_id = e.sequence_id and v.version = e.pinned_version), seq.graph);
  nid := p_node_id;

  loop
    guard := guard + 1;
    if guard > 100 then
      perform outreach_complete_enrollment(e.id, 'failed', 'graph_loop');
      return;
    end if;
    n := g->'nodes'->nid;
    if nid is null or n is null then
      perform outreach_complete_enrollment(e.id, 'completed', 'end_of_graph');
      return;
    end if;
    t := n->>'type';
    update outreach_enrollments set current_node_id = nid, node_entered_at = now(), wait_until = null, status = 'active', wait_reason = null where id = e.id;

    if coalesce(n->>'mode','auto') = 'manual' and outreach_is_executable_node(t) then
      perform outreach_create_node_task(e, n, 'manual_node');
      update outreach_enrollments set status = 'waiting_task' where id = e.id;
      return;
    end if;

    if t = 'start' then
      nid := n->>'next'; continue;

    elsif t = 'end' then
      perform outreach_complete_enrollment(e.id, 'completed', coalesce(n->'config'->>'reason','end'));
      return;

    elsif t = 'delay' then
      amount := coalesce((n->'config'->>'amount')::numeric, 1); unit := coalesce(n->'config'->>'unit','days');
      jit := coalesce((n->'config'->>'jitter_pct')::numeric, 0);
      iv := case unit when 'minutes' then make_interval(mins => amount::int) when 'hours' then make_interval(hours => amount::int) else make_interval(days => amount::int) end;
      iv := iv * (1 + (random()*2 - 1) * jit / 100.0);
      update outreach_enrollments set status = 'waiting_delay', wait_until = greatest(now() + iv, coalesce(p_not_before, now())) where id = e.id;
      return;

    elsif t = 'condition' then
      branch := case when outreach_eval_condition(n->'config', e.lead_id, e.sender_id) then 'true' else 'false' end;
      nid := coalesce(n->'branches'->>branch, n->>'next'); continue;

    elsif t = 'ab_split' then
      select s.branch into branch from outreach_split_assignments s where s.enrollment_id = e.id and s.node_id = nid;
      if branch is null then
        branch := outreach_pick_variant(e.id, nid, n->'config'->'branches');
        insert into outreach_split_assignments(enrollment_id, node_id, sequence_id, branch) values (e.id, nid, e.sequence_id, branch) on conflict do nothing;
      end if;
      nid := coalesce(n->'branches'->>branch, n->>'next'); continue;

    elsif t = 'ai_route' then
      select * into dec from outreach_ai_route_decisions d where d.enrollment_id = e.id and d.node_id = nid;
      if found and dec.decided_at is not null then
        nid := coalesce(n->'branches'->>coalesce(dec.branch,'else'), n->'branches'->>'else', n->>'next'); continue;
      end if;
      insert into outreach_ai_route_decisions(enrollment_id, node_id, workspace_id, lead_id) values (e.id, nid, e.workspace_id, e.lead_id) on conflict do nothing;
      update outreach_enrollments set status = 'waiting_task', wait_reason = 'ai_route' where id = e.id;
      return;

    elsif t = 'add_tag' then
      insert into outreach_lead_tags(lead_id, tag_id) select e.lead_id, (n->'config'->>'tag_id')::uuid where (n->'config'->>'tag_id') is not null on conflict do nothing;
      nid := n->>'next'; continue;
    elsif t = 'remove_tag' then
      delete from outreach_lead_tags where lead_id = e.lead_id and tag_id::text = n->'config'->>'tag_id';
      nid := n->>'next'; continue;
    elsif t = 'change_list' then
      update outreach_leads set list_id = (n->'config'->>'list_id')::uuid where id = e.lead_id;
      nid := n->>'next'; continue;
    elsif t = 'change_stage' then
      update outreach_leads set stage_id = (n->'config'->>'stage_id')::uuid where id = e.lead_id;
      nid := n->>'next'; continue;

    elsif t = 'call_webhook' then
      insert into outreach_outbound_webhook_deliveries(webhook_id, workspace_id, event, payload)
      select w.id, e.workspace_id, 'sequence.webhook',
        jsonb_build_object('event','sequence.webhook','workspace_id', e.workspace_id, 'at', now(),
          'data', jsonb_build_object('enrollment_id', e.id, 'lead_id', e.lead_id, 'sender_id', e.sender_id, 'sequence_id', e.sequence_id, 'node_id', nid,
                                     'lead', (select to_jsonb(l) - 'custom' || jsonb_build_object('custom', l.custom) from outreach_leads l where l.id = e.lead_id)))
      from outreach_outbound_webhooks w where w.id::text = n->'config'->>'webhook_id' and w.active;
      nid := n->>'next'; continue;

    elsif t = 'rotate_sender' then
      pool := seq.sender_pool;
      pos := array_position(pool, e.sender_id);
      nxt_sender := null;
      if pos is not null and array_length(pool,1) > 1 and e.rotation_count < coalesce((n->'config'->>'max_rotations')::int, 2) then
        nxt_sender := pool[(pos % array_length(pool,1)) + 1];
      end if;
      if nxt_sender is null or nxt_sender = e.sender_id then nid := n->>'next'; continue; end if;
      insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, pinned_version, lead_id, sender_id, status, current_node_id, rotation_count, priority, created_by, reply_ignored_before)
      values (e.workspace_id, e.sequence_id, seq.head_version, e.pinned_version, e.lead_id, nxt_sender, 'active', coalesce(n->'config'->>'restart_from', g->>'start'), e.rotation_count + 1, e.priority, e.created_by, e.reply_ignored_before)
      on conflict do nothing returning id into new_id;
      insert into outreach_lead_sender_state(lead_id, sender_id) values (e.lead_id, nxt_sender) on conflict do nothing;
      perform outreach_complete_enrollment(e.id, 'completed', 'rotated');
      if new_id is not null then perform outreach_enter_node(new_id, coalesce(n->'config'->>'restart_from', g->>'start')); end if;
      return;

    elsif t = 'change_sender' then
      if coalesce(n->'config'->>'sender_id','next_in_pool') = 'next_in_pool' then
        pool := seq.sender_pool; pos := array_position(pool, e.sender_id);
        target := case when pos is null or array_length(pool,1) < 2 then null else pool[(pos % array_length(pool,1)) + 1] end;
      else
        target := (n->'config'->>'sender_id')::uuid;
      end if;
      if target is not null and target <> e.sender_id and not exists (
          select 1 from outreach_enrollments x where x.lead_id = e.lead_id and x.sender_id = target and x.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')) then
        update outreach_enrollments set sender_id = target where id = e.id;
        insert into outreach_lead_sender_state(lead_id, sender_id) values (e.lead_id, target) on conflict do nothing;
        e.sender_id := target;
      end if;
      nid := n->>'next'; continue;

    elsif t = 'send_to_sequence' then
      perform outreach_complete_enrollment(e.id, 'completed', 'sent_to_sequence');
      if (n->'config'->>'sequence_id') is not null then
        perform outreach_enroll_leads((n->'config'->>'sequence_id')::uuid, array[e.lead_id], null, e.priority, true);
      end if;
      return;

    elsif t = 'manual_task' then
      perform outreach_create_node_task(e, n, 'manual_node');
      update outreach_enrollments set status = 'waiting_task' where id = e.id;
      return;

    elsif t = 'call_task' then
      perform outreach_create_node_task(e, n, 'call');
      update outreach_enrollments set status = 'waiting_task' where id = e.id;
      return;

    elsif t = 'ai_draft_approval' then
      perform outreach_create_node_task(e, n, 'review_ai_draft');
      update outreach_enrollments set status = 'waiting_task' where id = e.id;
      return;

    elsif t = 'wait_connection' then
      select relation into rel from outreach_lead_sender_state where lead_id = e.lead_id and sender_id = e.sender_id;
      if rel = 'first' then
        nid := n->'branches'->>'connected'; p_not_before := coalesce(p_not_before, now()); continue;
      end if;
      update outreach_enrollments set status = 'waiting_connection', wait_until = now() + make_interval(days => coalesce((n->'config'->>'window_days')::int, 14)) where id = e.id;
      return;

    elsif outreach_is_executable_node(t) then
      if n ? 'delay' and (n->'delay'->>'amount') is not null then
        amount := (n->'delay'->>'amount')::numeric; unit := coalesce(n->'delay'->>'unit','days'); jit := coalesce((n->'delay'->>'jitter_pct')::numeric,0);
        iv := case unit when 'minutes' then make_interval(mins => amount::int) when 'hours' then make_interval(hours => amount::int) else make_interval(days => amount::int) end;
        iv := iv * (1 + (random()*2 - 1) * jit / 100.0);
        update outreach_enrollments set status = 'waiting_delay', wait_until = greatest(now() + iv, coalesce(p_not_before, now())) where id = e.id;
      else
        update outreach_enrollments set status = 'active', wait_until = coalesce(p_not_before, now()) where id = e.id;
      end if;
      return;
    else
      perform outreach_complete_enrollment(e.id, 'failed', 'unknown_node_type');
      return;
    end if;
  end loop;
end $$;

create or replace function outreach_advance_enrollment(p_enrollment uuid, p_from_node text, p_branch text default null, p_not_before timestamptz default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare e outreach_enrollments%rowtype; g jsonb; n jsonb; nxt text;
begin
  select * into e from outreach_enrollments where id = p_enrollment;
  if not found or e.status not in ('active','waiting_connection','waiting_delay','waiting_task') then return; end if;
  g := outreach_enrollment_graph(e.id);
  n := g->'nodes'->coalesce(p_from_node, e.current_node_id);
  if n is null then
    -- the step was removed by a publish: continue from the live graph's view of "after nothing" = finish cleanly
    perform outreach_complete_enrollment(e.id, 'completed', 'node_missing');
    return;
  end if;
  if p_branch is not null and (n->'branches' ? p_branch) then nxt := n->'branches'->>p_branch;
  else nxt := n->>'next'; end if;
  perform outreach_enter_node(e.id, nxt, p_not_before);
end $$;

-- task text for call tasks carries the phone number + script
create or replace function outreach_create_node_task(p_e outreach_enrollments, p_node jsonb, p_kind outreach_task_kind_t)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare tid uuid; ttl text; bdy text; cid uuid; l outreach_leads;
begin
  select client_id into cid from outreach_sequences where id = p_e.sequence_id;
  select * into l from outreach_leads where id = p_e.lead_id;
  ttl := coalesce(nullif(p_node->'config'->>'title',''), p_node->>'label', replace(p_node->>'type','_',' ')) || ' — ' || coalesce(l.full_name, l.public_identifier::text, l.email_work::text, 'lead');
  bdy := coalesce(p_node->'config'->>'body', p_node->'config'->>'script', p_node->'config'->>'text', p_node->'config'->>'note', p_node->'config'->'ai'->>'brief');
  if p_kind = 'call' then
    bdy := 'Phone: ' || coalesce(l.phone, l.custom->>'phone', 'not on file') || E'\n\n' || coalesce(bdy, '');
  end if;
  insert into outreach_tasks(workspace_id, client_id, kind, lead_id, sender_id, enrollment_id, node_id, title, body, draft_kind, due_at)
  values (p_e.workspace_id, cid, p_kind, p_e.lead_id, p_e.sender_id, p_e.id, p_node->>'id', ttl, bdy,
          case when p_kind in ('call','reply_hold') then null else coalesce(p_node->'config'->>'kind', case p_node->>'type' when 'send_invite' then 'invite_note' when 'comment_latest_post' then 'comment' else 'message' end) end,
          now() + interval '1 day')
  returning id into tid;
  perform outreach_emit_event(p_e.workspace_id, 'task.created', jsonb_build_object('id', tid, 'kind', p_kind, 'lead_id', p_e.lead_id, 'enrollment_id', p_e.id));
  return tid;
end $$;

-- -----------------------------------------------------------------------------
-- Periodic releaser: delays, connection windows, plus the two new bounded waits
-- (nobody waits forever on enrichment, AI review or AI routing).
-- -----------------------------------------------------------------------------
create or replace function outreach_release_waits() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare r record; cnt int := 0;
begin
  for r in select e.id, e.current_node_id from outreach_enrollments e
            join outreach_sequences s on s.id = e.sequence_id
           where e.status = 'waiting_delay' and e.wait_until <= now() and s.status = 'active'
             and (outreach_enrollment_graph(e.id)->'nodes'->e.current_node_id->>'type') = 'delay'
           limit 500 loop
    perform outreach_advance_enrollment(r.id, r.current_node_id, null);
    cnt := cnt + 1;
  end loop;
  for r in select e.id, e.current_node_id from outreach_enrollments e
            join outreach_sequences s on s.id = e.sequence_id
           where e.status = 'waiting_connection' and e.wait_until <= now() and s.status = 'active'
           limit 500 loop
    perform outreach_advance_enrollment(r.id, r.current_node_id, 'no_connect');
    cnt := cnt + 1;
  end loop;
  -- enrichment wait: give up after 72h and start anyway (fallbacks render)
  for r in select e.id, e.lead_id from outreach_enrollments e
           where e.status = 'waiting_task' and e.wait_reason = 'enrichment' and e.node_entered_at < now() - interval '72 hours' limit 200 loop
    update outreach_leads set enrich_status = 'failed' where id = r.lead_id and enrich_status = 'waiting';
    delete from outreach_enrich_queue where lead_id = r.lead_id;
    perform outreach_release_waiting(r.lead_id, 'enrichment');
    cnt := cnt + 1;
  end loop;
  -- AI routing: no decision after 6h → the "everything else" branch
  for r in select d.enrollment_id, d.node_id from outreach_ai_route_decisions d
           where d.decided_at is null and (d.requested_at < now() - interval '6 hours' or (d.attempts >= 3 and d.requested_at < now() - interval '10 minutes')) limit 200 loop
    perform outreach_ai_route_decide(r.enrollment_id, r.node_id, 'else', 'No AI decision was available; used the fallback branch', '[]'::jsonb, null);
    cnt := cnt + 1;
  end loop;
  cnt := cnt + outreach_ai_fail_exhausted();
  return cnt;
end $$;

-- -----------------------------------------------------------------------------
-- Planner demand: pinned graph, variant-resolved config, new step types
-- -----------------------------------------------------------------------------
drop function if exists outreach_planner_demand(uuid, timestamptz);
create or replace function outreach_planner_demand(p_sender uuid, p_until timestamptz)
returns table(enrollment_id uuid, lead_id uuid, sequence_id uuid, node_id text, node jsonb, action_type outreach_action_type_t,
              earliest timestamptz, priority int, created_at timestamptz, needs_profile boolean, subtask boolean, settings jsonb, variant_id text, needs_posts boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
declare r record; n jsonb; subs jsonb; k int; last_sub timestamptz; st jsonb; g jsonb; cfg jsonb; ai_keys text[];
begin
  for r in
    select e.id, e.lead_id, e.sequence_id, e.current_node_id, e.status, e.wait_until, e.node_entered_at, e.priority, e.created_at, e.pinned_version,
           s.graph, s.settings, l.provider_id, l.last_profile_fetch_at
    from outreach_enrollments e
    join outreach_sequences s on s.id = e.sequence_id and s.status = 'active'
    join outreach_leads l on l.id = e.lead_id
    where e.sender_id = p_sender
      and e.status in ('active','waiting_delay','waiting_connection')
      and coalesce(e.wait_until, e.node_entered_at) <= p_until
      and not l.do_not_contact and not l.unsubscribed
    order by e.priority, e.created_at
  loop
    g := r.graph;
    if r.pinned_version is not null then
      select v.graph into g from outreach_sequence_versions v where v.sequence_id = r.sequence_id and v.version = r.pinned_version;
      g := coalesce(g, r.graph);
    end if;
    n := g->'nodes'->r.current_node_id;
    if n is null then continue; end if;
    if r.status = 'waiting_connection' then
      subs := n->'config'->'subtasks';
      if subs is null or jsonb_typeof(subs) <> 'array' or jsonb_array_length(subs) = 0 then continue; end if;
      select count(*), max(a.created_at) into k, last_sub from outreach_actions a where a.enrollment_id = r.id and a.node_id = r.current_node_id and coalesce((a.payload->>'subtask')::boolean,false);
      if k >= jsonb_array_length(subs) then continue; end if;
      if last_sub is not null and last_sub > now() - interval '2 days' then continue; end if;
      st := subs->k;
      if (st->>'type') not in ('visit_profile','like_latest_post') then continue; end if;
      enrollment_id := r.id; lead_id := r.lead_id; sequence_id := r.sequence_id; node_id := r.current_node_id;
      node := st || jsonb_build_object('id', r.current_node_id, 'subtask_index', k);
      action_type := outreach_node_action_type(st->>'type');
      earliest := greatest(coalesce(last_sub, r.node_entered_at) + interval '2 days', now());
      priority := r.priority; created_at := r.created_at; needs_profile := false; subtask := true; settings := r.settings; variant_id := null;
      needs_posts := (st->>'type') = 'like_latest_post';
      return next;
      continue;
    end if;
    if (n->>'type') = 'delay' or not outreach_is_executable_node(n->>'type') then continue; end if;
    if exists (select 1 from outreach_actions a where a.enrollment_id = r.id and a.node_id = r.current_node_id and a.status in ('queued','reserved')
               and not coalesce((a.payload->>'prefetch')::boolean,false)) then continue; end if;
    cfg := outreach_node_config_for(r.id, n);
    enrollment_id := r.id; lead_id := r.lead_id; sequence_id := r.sequence_id; node_id := r.current_node_id;
    node := jsonb_set(n, '{config}', cfg);
    variant_id := cfg->>'variant_id';
    action_type := outreach_node_action_type(n->>'type');
    earliest := coalesce(r.wait_until, r.node_entered_at);
    priority := r.priority; created_at := r.created_at; subtask := false; settings := r.settings;
    needs_profile := (n->>'type') in ('send_invite','send_message','send_voice_note','send_inmail','comment_latest_post','like_latest_post','endorse_skills','follow_profile')
                     and (r.provider_id is null or r.last_profile_fetch_at is null or r.last_profile_fetch_at < now() - interval '7 days');
    -- posts are fetched only when something will use them (item 13)
    needs_posts := (n->>'type') in ('like_latest_post','comment_latest_post')
                   or position('enrich.recent_post' in cfg::text) > 0
                   or exists (select 1 from outreach_ai_variables av join outreach_sequences q on q.id = r.sequence_id and q.workspace_id = av.workspace_id
                              where av.needs_posts and cfg::text ~ ('\{\{\s*ai\.' || av.key || '\M'));
    return next;
  end loop;
end $$;
revoke execute on function outreach_planner_demand(uuid,timestamptz) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Budgets: InMail speed guard (item 12). No more than ~50% above last week's daily average,
-- never below 3/day, and only ever LOWERS the cap the warmup table already allows.
-- -----------------------------------------------------------------------------
create or replace function outreach_inmail_guard(p_sender uuid, p_day date) returns int
language sql stable security definer set search_path = public, extensions as $$
  select greatest(3, ceil(1.5 * coalesce(sum(b.used), 0) / 7.0))::int
  from outreach_sender_budgets b
  where b.sender_id = p_sender and b.action_type = 'inmail' and b.day >= p_day - 7 and b.day < p_day
$$;

create or replace function outreach_effective_cap(p_sender uuid, p_type outreach_action_type_t) returns int
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; ceil_v int; warm_v int; man_v int; base int; mult numeric := 1;
begin
  select * into s from outreach_senders where id = p_sender;
  select per_day into ceil_v from outreach_platform_ceilings where action_type = p_type;
  if ceil_v is null then return 0; end if;
  if p_type in ('reply','call_api','relations_poll','find_email') then return ceil_v; end if;
  select per_day into warm_v from outreach_warmup_caps where level = s.warmup_level and action_type = p_type;
  base := least(ceil_v, coalesce(warm_v, ceil_v));
  if s.manual_caps ? p_type::text then
    man_v := (s.manual_caps->>p_type::text)::int;
    base := least(base, greatest(man_v, 0));
  end if;
  if s.health_score < 50 then mult := 0;
  elsif s.health_score < 70 then mult := 0.6; end if;
  return floor(base * mult)::int;
end $$;

create or replace function outreach_plan_budgets(p_sender uuid, p_day date)
returns setof outreach_sender_budgets
language plpgsql security definer set search_path = public, extensions as $$
declare t outreach_action_type_t; base int; capv int; has_window boolean; jitter numeric; wk int; wk_ceiling int;
begin
  select exists(select 1 from outreach_schedule_windows(p_sender, p_day)) into has_window;
  for t in select action_type from outreach_platform_ceilings loop
    base := outreach_effective_cap(p_sender, t);
    if t in ('reply','call_api','relations_poll','find_email') then
      capv := base;
    elsif not has_window then
      capv := 0;
    else
      jitter := 0.9 + random() * 0.2;
      capv := floor(base * jitter)::int;
      if base >= 1 and capv < 1 then capv := 1; end if;
      if t = 'invite' then
        select per_week into wk_ceiling from outreach_platform_ceilings where action_type = 'invite';
        wk := outreach_weekly_invites_used(p_sender, p_day)
              - coalesce((select used + reserved from outreach_sender_budgets where sender_id = p_sender and day = p_day and action_type = 'invite'), 0);
        capv := greatest(least(capv, coalesce(wk_ceiling, 150) - wk), 0);
      elsif t = 'inmail' and capv > 0 then
        capv := least(capv, outreach_inmail_guard(p_sender, p_day));
      end if;
    end if;
    insert into outreach_sender_budgets(sender_id, day, action_type, cap)
    values (p_sender, p_day, t, capv)
    on conflict (sender_id, day, action_type) do update
      set cap = greatest(excluded.cap, outreach_sender_budgets.used + outreach_sender_budgets.reserved);
  end loop;
  return query select * from outreach_sender_budgets where sender_id = p_sender and day = p_day;
end $$;

-- claim: find_email, like call_api, is not LinkedIn traffic and ignores the schedule window
create or replace function outreach_claim_due_actions(p_limit int default 200)
returns setof outreach_actions
language plpgsql security definer set search_path = public, extensions as $$
declare r record; d date; ok boolean;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for r in
    select a.id, a.sender_id, a.action_type, a.status
    from outreach_actions a
    where a.id in (
      select id from (
        select a2.id, row_number() over (partition by a2.sender_id order by a2.scheduled_for) rn
        from outreach_actions a2
        join outreach_senders s on s.id = a2.sender_id
        where a2.status = 'queued' and a2.scheduled_for <= now()
          and s.status = 'ok' and s.deleted_at is null
          and (s.paused_until is null or s.paused_until < now())
          and (a2.action_type in ('reply','call_api','find_email') or outreach_in_schedule(s.id, now()))
          and not (a2.action_type = 'invite' and s.invite_blocked_until is not null and s.invite_blocked_until > now())
          and not exists (select 1 from outreach_actions r2 where r2.sender_id = a2.sender_id and r2.status = 'reserved')
      ) x where x.rn = 1 limit p_limit
    )
    for update skip locked
  loop
    if r.status <> 'queued' then continue; end if;
    d := outreach_sender_local_date(r.sender_id, now());
    ok := outreach_reserve_budget(r.sender_id, d, r.action_type);
    if ok then
      update outreach_actions set status = 'reserved', reserved_at = now() where id = r.id;
      return query select * from outreach_actions where id = r.id;
    else
      update outreach_actions set scheduled_for = now() + interval '1 day', decision = 'budget_deferred' where id = r.id;
    end if;
  end loop;
end $$;

-- fail_action: adds the 'suppressed' decision so a blacklist entry added mid-campaign is a clean exit, not a failure
create or replace function outreach_fail_action(p_id uuid, p_code text, p_decision text, p_retry_at timestamptz default null, p_branch text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare a outreach_actions%rowtype; d date; is_main boolean;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into a from outreach_actions where id = p_id for update;
  if not found or a.status <> 'reserved' then return; end if;
  d := outreach_sender_local_date(a.sender_id, coalesce(a.reserved_at, now()));
  perform outreach_release_budget(a.sender_id, d, a.action_type);
  is_main := a.enrollment_id is not null and not coalesce((a.payload->>'prefetch')::boolean,false) and not coalesce((a.payload->>'subtask')::boolean,false);

  if p_decision = 'retry' then
    update outreach_actions set status = 'queued', reserved_at = null, scheduled_for = coalesce(p_retry_at, now() + interval '15 minutes'),
      attempt = attempt + 1, error_code = p_code, decision = p_decision where id = p_id;
  elsif p_decision = 'skip_node' then
    update outreach_actions set status = 'skipped', executed_at = now(), error_code = p_code, decision = p_decision where id = p_id;
    if is_main then perform outreach_advance_enrollment(a.enrollment_id, a.node_id, null); end if;
  elsif p_decision = 'branch' then
    update outreach_actions set status = 'skipped', executed_at = now(), error_code = p_code, decision = p_decision || ':' || coalesce(p_branch,'') where id = p_id;
    if is_main then perform outreach_advance_enrollment(a.enrollment_id, a.node_id, p_branch); end if;
  elsif p_decision = 'suppressed' then
    update outreach_actions set status = 'cancelled', executed_at = now(), error_code = p_code, decision = 'suppressed' where id = p_id;
    if a.enrollment_id is not null then perform outreach_complete_enrollment(a.enrollment_id, 'exited_suppressed', coalesce(p_code, 'suppressed')); end if;
  elsif p_decision = 'replied' then
    update outreach_actions set status = 'cancelled', executed_at = now(), error_code = p_code, decision = 'reply_exit' where id = p_id;
    if a.enrollment_id is not null then perform outreach_complete_enrollment(a.enrollment_id, 'exited_replied', 'replied'); end if;
  elsif p_decision in ('fail_enrollment','mark_lead_invalid') then
    update outreach_actions set status = 'failed', executed_at = now(), error_code = p_code, decision = p_decision where id = p_id;
    if p_decision = 'mark_lead_invalid' and a.lead_id is not null then
      insert into outreach_lead_sender_state(lead_id, sender_id, relation) values (a.lead_id, a.sender_id, 'invalid')
      on conflict (lead_id, sender_id) do update set relation = 'invalid', updated_at = now();
    end if;
    if is_main then perform outreach_complete_enrollment(a.enrollment_id, 'failed', coalesce(p_code, p_decision)); end if;
  elsif p_decision = 'sender_cap_hit' then
    update outreach_actions set status = 'cancelled', error_code = p_code, decision = p_decision where id = p_id;
    update outreach_senders set invite_blocked_until = coalesce(p_retry_at, now() + interval '7 days') where id = a.sender_id;
    update outreach_actions set status = 'cancelled', decision = 'sender_cap_hit_cascade'
     where sender_id = a.sender_id and action_type = 'invite' and status = 'queued' and scheduled_for < coalesce(p_retry_at, now() + interval '7 days');
    insert into outreach_sender_events(sender_id, kind, data) values (a.sender_id, 'reject', jsonb_build_object('code', p_code, 'decision', p_decision, 'until', p_retry_at, 'limit_hit', true));
  elsif p_decision = 'sender_pause' then
    update outreach_actions set status = 'queued', reserved_at = null, scheduled_for = coalesce(p_retry_at, now() + interval '24 hours'), error_code = p_code, decision = p_decision where id = p_id;
    update outreach_senders set paused_until = coalesce(p_retry_at, now() + interval '24 hours') where id = a.sender_id;
    insert into outreach_sender_events(sender_id, kind, data) values (a.sender_id, 'reject', jsonb_build_object('code', p_code, 'decision', p_decision, 'until', p_retry_at));
  elsif p_decision = 'sender_credentials' then
    update outreach_actions set status = 'queued', reserved_at = null, error_code = p_code, decision = p_decision where id = p_id;
    update outreach_senders set status = 'credentials', status_reason = coalesce(p_code,'unauthorized'), last_disconnect_at = now() where id = a.sender_id and status = 'ok';
  elsif p_decision = 'cancel' then
    update outreach_actions set status = 'cancelled', error_code = p_code, decision = p_decision where id = p_id;
  else
    update outreach_actions set status = 'failed', executed_at = now(), error_code = p_code, decision = coalesce(p_decision,'failed') where id = p_id;
  end if;

  if p_decision not in ('skip_node','branch','cancel','suppressed','replied') then
    insert into outreach_sender_events(sender_id, kind, data) values (a.sender_id, 'reject', jsonb_build_object('action_id', a.id, 'type', a.action_type, 'code', p_code, 'decision', p_decision));
  end if;
end $$;
revoke execute on function outreach_fail_action(uuid,text,text,timestamptz,text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Item 1 — reply stops the lead everywhere
-- -----------------------------------------------------------------------------
-- Is this enrollment blocked by a reply? The executor asks the database instead of reading lss.replied, so
-- a lead re-enrolled on purpose, or resumed after an out-of-office, is not blocked by an old reply.
create or replace function outreach_enrollment_reply_blocked(p_enrollment uuid, p_action_sender uuid default null) returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
declare e outreach_enrollments%rowtype; st jsonb; since timestamptz; l_at timestamptz;
begin
  select * into e from outreach_enrollments where id = p_enrollment;
  if not found then return false; end if;
  select settings into st from outreach_sequences where id = e.sequence_id;
  if coalesce((st->>'stop_on_reply')::boolean, true) = false then return false; end if;
  since := coalesce(e.reply_ignored_before, e.created_at);
  if coalesce(st->>'stop_on_reply_scope','lead') = 'sender' then
    return exists (select 1 from outreach_lead_sender_state x where x.lead_id = e.lead_id and x.sender_id in (e.sender_id, coalesce(p_action_sender, e.sender_id))
                   and x.replied and x.last_inbound_at > since);
  end if;
  select last_replied_at into l_at from outreach_leads where id = e.lead_id;
  return l_at is not null and l_at > since;
end $$;
revoke execute on function outreach_enrollment_reply_blocked(uuid,uuid) from public, anon, authenticated;

create or replace function outreach_hold_enrollment(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e outreach_enrollments%rowtype; tid uuid; cid uuid; lname text;
begin
  update outreach_enrollments set paused_from = case when status = 'paused' then paused_from else status end, status = 'paused', held_at = now(), hold_reason = p_reason
   where id = p_id and status in ('active','waiting_connection','waiting_delay','waiting_task','paused') and held_at is null
   returning * into e;
  if not found then return; end if;
  select client_id into cid from outreach_sequences where id = e.sequence_id;
  select coalesce(full_name, public_identifier::text, email_work::text, 'lead') into lname from outreach_leads where id = e.lead_id;
  insert into outreach_tasks(workspace_id, client_id, kind, lead_id, sender_id, enrollment_id, node_id, chat_id, title, body, due_at)
  values (e.workspace_id, cid, 'reply_hold', e.lead_id, e.sender_id, e.id, e.current_node_id,
          (select c.id from outreach_chats c where c.lead_id = e.lead_id and c.last_direction = 'in' order by c.last_message_at desc nulls last limit 1),   -- the thread that holds the reply
          'Replied — review before the next step: ' || lname,
          'This lead replied and the sequence is set to hold for review. Resume to send the next step, or exit the lead. Held leads appear on the attention list and are exited automatically after the hold limit.',
          now() + interval '1 day')
  returning id into tid;
  perform outreach_emit_event(e.workspace_id, 'enrollment.held', jsonb_build_object('id', e.id, 'lead_id', e.lead_id, 'sender_id', e.sender_id, 'sequence_id', e.sequence_id, 'reason', p_reason, 'task_id', tid));
end $$;
revoke execute on function outreach_hold_enrollment(uuid,text) from public, anon, authenticated;

create or replace function outreach_trg_reply_exit() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare r record; n jsonb; ws uuid; ch text; at_ts timestamptz;
begin
  if not (new.replied and (not coalesce(old.replied, false) or new.last_inbound_at is distinct from old.last_inbound_at)) then return new; end if;
  select workspace_id, case when provider = 'LINKEDIN' then 'linkedin' else 'email' end into ws, ch from outreach_senders where id = new.sender_id;
  at_ts := coalesce(new.last_inbound_at, now());
  update outreach_leads set last_replied_at = greatest(coalesce(last_replied_at, at_ts), at_ts), last_replied_channel = ch where id = new.lead_id;

  for r in select e.id, e.sender_id, e.current_node_id, e.status, e.paused_from, e.wait_until, e.held_at, e.created_at, e.reply_ignored_before, s.settings
             from outreach_enrollments e join outreach_sequences s on s.id = e.sequence_id
            where e.lead_id = new.lead_id and e.workspace_id = ws
              and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
    if coalesce((r.settings->>'stop_on_reply')::boolean, true) = false then continue; end if;
    if coalesce(r.settings->>'stop_on_reply_scope','lead') = 'sender' and r.sender_id <> new.sender_id then continue; end if;
    if at_ts < coalesce(r.reply_ignored_before, r.created_at) then continue; end if;   -- backfilled history older than this enrollment
    if r.held_at is not null then continue; end if;
    n := outreach_enrollment_graph(r.id)->'nodes'->r.current_node_id;
    if coalesce((n->'config'->>'send_always')::boolean, false) then continue; end if;
    if coalesce(r.settings->>'on_reply','exit') = 'hold' then
      perform outreach_hold_enrollment(r.id, 'replied');
    else
      update outreach_enrollments set prev_status = case when status = 'paused' then coalesce(paused_from, 'active') else status end,
             prev_wait_until = wait_until, exited_by_message_at = at_ts where id = r.id;
      perform outreach_complete_enrollment(r.id, 'exited_replied', 'replied');
    end if;
  end loop;

  -- every queued/reserved action for this lead, on ANY sender, unless its enrollment deliberately stayed live
  update outreach_actions a set status = 'cancelled', decision = 'reply_exit'
   where a.lead_id = new.lead_id and a.workspace_id = ws and a.status in ('queued','reserved') and a.action_type <> 'reply'
     and not exists (select 1 from outreach_enrollments e where e.id = a.enrollment_id and e.status in ('active','waiting_connection','waiting_delay','waiting_task'));
  return new;
end $$;
drop trigger if exists outreach_lss_reply_exit on outreach_lead_sender_state;
create trigger outreach_lss_reply_exit after update of replied, last_inbound_at on outreach_lead_sender_state
  for each row execute function outreach_trg_reply_exit();

-- Resume: also clears a hold, and marks everything before "now" as already handled
create or replace function outreach_resume_enrollment(p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare e outreach_enrollments%rowtype;
begin
  select * into e from outreach_enrollments where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(e.workspace_id, 'member');
  if not outreach_client_visible(e.workspace_id, (select sq_.client_id from outreach_sequences sq_ where sq_.id = e.sequence_id)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  update outreach_enrollments set status = coalesce(paused_from,'active'), paused_from = null,
         reply_ignored_before = case when held_at is not null then now() else reply_ignored_before end, held_at = null, hold_reason = null,
         wait_until = case when coalesce(paused_from,'active') in ('active','waiting_delay') then greatest(coalesce(wait_until, now()), now()) else wait_until end
   where id = p_id and status = 'paused';
  if e.held_at is not null then
    update outreach_lead_sender_state set replied = false where lead_id = e.lead_id and replied;
    update outreach_tasks set completed_at = now(), completed_by = auth.uid(), result = jsonb_build_object('decision','resume') where enrollment_id = p_id and kind = 'reply_hold' and completed_at is null;
    perform outreach_emit_event(e.workspace_id, 'enrollment.resumed', jsonb_build_object('id', e.id, 'lead_id', e.lead_id, 'reason', 'hold_released'));
  end if;
end $$;

create or replace function outreach_exit_enrollment(p_id uuid, p_reason text default 'manual')
returns void language plpgsql security definer set search_path = public, extensions as $$
declare e outreach_enrollments%rowtype;
begin
  select * into e from outreach_enrollments where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(e.workspace_id, 'member');
  if not outreach_client_visible(e.workspace_id, (select sq_.client_id from outreach_sequences sq_ where sq_.id = e.sequence_id)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  perform outreach_complete_enrollment(p_id, case when e.held_at is not null and e.hold_reason = 'replied' then 'exited_replied'::outreach_enrollment_status_t else 'exited_manual' end, p_reason);
  update outreach_enrollments set held_at = null where id = p_id and held_at is not null;
  update outreach_tasks set completed_at = now(), completed_by = auth.uid(), result = jsonb_build_object('decision','exit') where enrollment_id = p_id and kind = 'reply_hold' and completed_at is null;
end $$;

-- Waits that are not tasks for a human: enrichment / AI review. Called by the workers and the review RPCs.
create or replace function outreach_release_waiting(p_lead uuid, p_reason text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare r record; cnt int := 0; keys text[]; needs_review boolean;
begin
  for r in select e.id, e.current_node_id, e.sequence_id, e.workspace_id, s.settings, s.graph
             from outreach_enrollments e join outreach_sequences s on s.id = e.sequence_id
            where e.lead_id = p_lead and e.status = 'waiting_task' and e.wait_reason = p_reason loop
    needs_review := false;
    if p_reason = 'enrichment' and coalesce((r.settings->>'hold_for_ai_review')::boolean, false) then
      keys := outreach_sequence_ai_keys(r.graph);
      if array_length(keys, 1) > 0 then
        perform outreach_ensure_ai_values(r.workspace_id, p_lead, keys, null);
        needs_review := exists (select 1 from outreach_ai_variables v left join outreach_ai_values x on x.variable_id = v.id and x.lead_id = p_lead
                                 where v.workspace_id = r.workspace_id and v.key = any(keys) and coalesce(x.status,'pending') in ('pending','generated'));
      end if;
    end if;
    if p_reason = 'ai_review' then
      keys := outreach_sequence_ai_keys(r.graph);
      if exists (select 1 from outreach_ai_variables v left join outreach_ai_values x on x.variable_id = v.id and x.lead_id = p_lead
                  where v.workspace_id = r.workspace_id and v.key = any(keys) and coalesce(x.status,'pending') in ('pending','generated')) then
        continue;   -- still something to review for this sequence
      end if;
    end if;
    if needs_review then
      update outreach_enrollments set wait_reason = 'ai_review', node_entered_at = now() where id = r.id;
    else
      update outreach_enrollments set status = 'active', wait_reason = null where id = r.id;
      perform outreach_enter_node(r.id, r.current_node_id);
      cnt := cnt + 1;
    end if;
  end loop;
  return cnt;
end $$;
revoke execute on function outreach_release_waiting(uuid,text) from public, anon, authenticated;

-- Which {{ai.<key>}} variables does a graph use?
create or replace function outreach_sequence_ai_keys(p_graph jsonb) returns text[]
language sql immutable as $$
  select coalesce(array_agg(distinct m[1]), '{}') from regexp_matches(coalesce(p_graph::text,''), '\{\{\s*ai\.([a-z][a-z0-9_]*)', 'g') m
$$;

create or replace function outreach_ensure_ai_values(p_ws uuid, p_lead uuid, p_keys text[], p_batch uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare cnt int;
begin
  insert into outreach_ai_values(workspace_id, lead_id, variable_id, batch_id, status)
  select p_ws, p_lead, v.id, p_batch, 'pending' from outreach_ai_variables v where v.workspace_id = p_ws and v.key = any(p_keys)
  on conflict (lead_id, variable_id) do nothing;
  get diagnostics cnt = row_count;
  return cnt;
end $$;
revoke execute on function outreach_ensure_ai_values(uuid,uuid,text[],uuid) from public, anon, authenticated;

-- AI routing verdict (item 15): stored once with its reason and the facts it relied on, then the lead moves on.
create or replace function outreach_ai_route_decide(p_enrollment uuid, p_node_id text, p_branch text, p_reason text, p_facts jsonb, p_model text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare e outreach_enrollments%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_ai_route_decisions set branch = coalesce(p_branch,'else'), reason = left(p_reason, 500), facts = coalesce(p_facts,'[]'::jsonb), model = p_model, decided_at = now()
   where enrollment_id = p_enrollment and node_id = p_node_id and decided_at is null;
  if not found then return; end if;
  select * into e from outreach_enrollments where id = p_enrollment;
  if e.status = 'waiting_task' and e.wait_reason = 'ai_route' and e.current_node_id = p_node_id then
    update outreach_enrollments set status = 'active', wait_reason = null where id = p_enrollment;
    perform outreach_advance_enrollment(p_enrollment, p_node_id, coalesce(p_branch,'else'));
  end if;
end $$;
revoke execute on function outreach_ai_route_decide(uuid,text,text,text,jsonb,text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- After classification (service) or a manual override: OOO resume, auto-stage, per-step "interested"
-- -----------------------------------------------------------------------------
create or replace function outreach_apply_reply_intent(p_message uuid, p_intent outreach_intent_t, p_return_date date default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare m outreach_messages%rowtype; c outreach_chats%rowtype; r record; resume_at timestamptz; days int; resumed int := 0; staged boolean := false;
        target outreach_stages%rowtype; cur_pos int; fr outreach_messages%rowtype; a outreach_actions%rowtype; seq uuid; wsset jsonb;
begin
  select * into m from outreach_messages where id = p_message;
  if not found then return jsonb_build_object('resumed', 0); end if;
  select * into c from outreach_chats where id = m.chat_id;
  if c.lead_id is null then return jsonb_build_object('resumed', 0); end if;
  select settings into wsset from outreach_workspaces where id = m.workspace_id;

  if p_intent = 'ooo' then
    for r in select e.*, s.settings as seq_settings from outreach_enrollments e join outreach_sequences s on s.id = e.sequence_id
              where e.lead_id = c.lead_id and s.status in ('active','paused')
                and ((e.status = 'exited_replied' and e.exit_reason = 'replied' and e.completed_at > now() - interval '30 days'
                      and e.exited_by_message_at is not null and abs(extract(epoch from e.exited_by_message_at - m.sent_at)) < 5)
                  or (e.status = 'paused' and e.held_at is not null and e.hold_reason = 'replied')) loop
      if coalesce((r.seq_settings->>'resume_after_ooo')::boolean, true) = false then continue; end if;
      days := greatest(coalesce((r.seq_settings->>'ooo_resume_days')::int, 7), 1);
      resume_at := case when p_return_date is not null and p_return_date > current_date and p_return_date < current_date + 120
                        then (p_return_date + 1)::timestamptz + interval '9 hours' else now() + make_interval(days => days) end;
      begin
        if r.status = 'paused' then
          update outreach_enrollments set status = case when coalesce(paused_from,'active') = 'active' then 'waiting_delay'::outreach_enrollment_status_t else coalesce(paused_from,'active') end,
                 paused_from = null, held_at = null, hold_reason = null, reply_ignored_before = m.sent_at + interval '1 second',
                 wait_until = greatest(coalesce(wait_until, resume_at), resume_at)
           where id = r.id;
          update outreach_tasks set completed_at = now(), result = jsonb_build_object('decision','resume','by','ooo') where enrollment_id = r.id and kind = 'reply_hold' and completed_at is null;
        else
          update outreach_enrollments set
                 status = case coalesce(r.prev_status,'active') when 'waiting_connection' then 'waiting_connection'::outreach_enrollment_status_t when 'waiting_task' then 'waiting_task' else 'waiting_delay' end,
                 wait_until = greatest(coalesce(r.prev_wait_until, resume_at), resume_at), completed_at = null, exit_reason = null,
                 prev_status = null, prev_wait_until = null, reply_ignored_before = m.sent_at + interval '1 second'
           where id = r.id and status = 'exited_replied';
        end if;
        resumed := resumed + 1;
        perform outreach_emit_event(r.workspace_id, 'enrollment.resumed', jsonb_build_object('id', r.id, 'lead_id', r.lead_id, 'sequence_id', r.sequence_id, 'reason', 'out_of_office', 'resume_at', resume_at));
      exception when unique_violation then null;   -- the lead was already re-enrolled with that sender
      end;
    end loop;
    if resumed > 0 then
      update outreach_lead_sender_state set replied = false where lead_id = c.lead_id and replied;
    end if;
  end if;

  -- an interested reply moves the lead to the workspace's "interested" stage (forward only), unless switched off
  if p_intent = 'interested' and coalesce((wsset->>'auto_stage_interested')::boolean, true) then
    select * into target from outreach_stages where workspace_id = m.workspace_id and kind = 'interested' order by position limit 1;
    if found then
      select st.position into cur_pos from outreach_leads l left join outreach_stages st on st.id = l.stage_id where l.id = c.lead_id;
      if cur_pos is null or cur_pos < target.position then
        update outreach_leads set stage_id = target.id where id = c.lead_id;
        staged := true;
      end if;
    end if;
    perform outreach_record_milestone(c.lead_id, 'interested', 'intent', null, null);
  end if;

  -- per-step "interested" counter for the canvas (the report recomputes from base tables)
  -- counted once per reply, whatever order the caller writes the intent in (flag on the first-reply message)
  if p_intent = 'interested' then
    select * into fr from outreach_messages x where x.chat_id = m.chat_id and x.is_first_reply and x.sent_at <= m.sent_at order by x.sent_at desc limit 1;
    if found and fr.replied_to_action_id is not null and not fr.counted_interested then
      update outreach_messages set counted_interested = true where id = fr.id;
      select * into a from outreach_actions where id = fr.replied_to_action_id;
      select sequence_id into seq from outreach_enrollments where id = a.enrollment_id;
      if seq is not null and a.node_id is not null then
        insert into outreach_node_stats(sequence_id, node_id, variant_id, interested) values (seq, a.node_id, coalesce(a.variant_id,''), 1)
        on conflict (sequence_id, node_id, variant_id) do update set interested = outreach_node_stats.interested + 1, updated_at = now();
      end if;
    end if;
  end if;
  return jsonb_build_object('resumed', resumed, 'staged', staged);
end $$;
revoke execute on function outreach_apply_reply_intent(uuid,outreach_intent_t,date) from public, anon, authenticated;

create or replace function outreach_record_milestone(p_lead uuid, p_kind text, p_source text, p_value numeric default null, p_currency text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare l outreach_leads%rowtype; e outreach_enrollments%rowtype; cid uuid;
begin
  select * into l from outreach_leads where id = p_lead;
  if not found then return; end if;
  select * into e from outreach_enrollments where lead_id = p_lead order by created_at desc limit 1;
  select client_id into cid from outreach_sequences where id = e.sequence_id;
  insert into outreach_lead_milestones(workspace_id, lead_id, kind, client_id, sequence_id, sender_id, enrollment_id, source, value, currency)
  values (l.workspace_id, p_lead, p_kind, coalesce(cid, l.client_id), e.sequence_id, e.sender_id, e.id, p_source, p_value, p_currency)
  on conflict (lead_id, kind) do update set value = coalesce(excluded.value, outreach_lead_milestones.value), currency = coalesce(excluded.currency, outreach_lead_milestones.currency);
end $$;
revoke execute on function outreach_record_milestone(uuid,text,text,numeric,text) from public, anon, authenticated;

-- manual intent override goes through the same consequences as the classifier
create or replace function outreach_set_intent(p_chat uuid, p_intent outreach_intent_t)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; mid uuid;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'member');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_FORBIDDEN'; end if;
  select id into mid from outreach_messages where chat_id = p_chat and direction = 'in' order by sent_at desc limit 1;
  if mid is not null then perform outreach_apply_reply_intent(mid, p_intent, null); end if;
  update outreach_chats set intent = p_intent where id = p_chat;
  update outreach_messages set intent = p_intent, classified_at = now() where id = mid;
  perform outreach_audit(c.workspace_id, 'chat.intent_override', 'chat', p_chat::text, jsonb_build_object('intent', p_intent));
end $$;

-- stage → milestone (funnel) + lead.updated event (supersedes 003 version)
create or replace function outreach_trg_lead_dnc() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare r record; k text; dv numeric;
begin
  if (new.do_not_contact and not old.do_not_contact) or (new.unsubscribed and not old.unsubscribed) then
    for r in select id from outreach_enrollments where lead_id = new.id and status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
      perform outreach_complete_enrollment(r.id, 'exited_suppressed', case when new.do_not_contact then 'do_not_contact' else 'unsubscribed' end);
    end loop;
    update outreach_actions set status = 'cancelled', decision = 'suppressed' where lead_id = new.id and status in ('queued','reserved') and action_type <> 'reply';
  end if;
  if new.stage_id is distinct from old.stage_id and new.stage_id is not null then
    select kind, deal_value into k, dv from outreach_stages where id = new.stage_id;
    if k in ('interested','meeting','won','lost') then
      perform outreach_record_milestone(new.id, k, 'stage', case when k = 'won' then coalesce(nullif(new.custom->>'deal_value','')::numeric, dv) end, new.custom->>'deal_currency');
    end if;
  end if;
  if new.do_not_contact <> old.do_not_contact or new.stage_id is distinct from old.stage_id or new.list_id is distinct from old.list_id then
    perform outreach_emit_event(new.workspace_id, 'lead.updated', jsonb_build_object('id', new.id, 'do_not_contact', new.do_not_contact, 'stage_id', new.stage_id, 'list_id', new.list_id));
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Item 4 — stamp attribution at ingest, on every path (webhook, backfill, mail)
-- -----------------------------------------------------------------------------
create or replace function outreach_trg_message_stamp() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; aid uuid;
begin
  if new.direction = 'in' and new.replied_to_action_id is null then
    -- the last AUTOMATED step in this thread. A teammate's manual reply is an action of type `reply`: answers to it are
    -- conversation, so they attach to the same step and are not counted as a new reply.
    select m.action_id into aid from outreach_messages m join outreach_actions a on a.id = m.action_id
     where m.chat_id = new.chat_id and m.direction = 'out' and a.action_type <> 'reply' and m.sent_at <= new.sent_at
     order by m.sent_at desc limit 1;
    if aid is not null then
      new.replied_to_action_id := aid;
      new.is_first_reply := not exists (select 1 from outreach_messages x where x.chat_id = new.chat_id and x.direction = 'in' and x.replied_to_action_id = aid);
    end if;
  elsif new.direction = 'out' and new.action_id is null then
    -- the invite note arrives through the messaging webhook without an action: link it to the invite that carried it
    select * into c from outreach_chats where id = new.chat_id;
    if c.lead_id is not null and not exists (select 1 from outreach_messages x where x.chat_id = new.chat_id) then
      select a.id into aid from outreach_actions a
       where a.lead_id = c.lead_id and a.sender_id = c.sender_id and a.action_type = 'invite' and a.status = 'sent'
         and a.executed_at > new.sent_at - interval '45 days' and coalesce((a.response->>'note_length')::int, 0) > 0
       order by a.executed_at desc limit 1;
      if aid is not null then new.action_id := aid; new.is_invite_note := true; end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists outreach_messages_stamp on outreach_messages;
create trigger outreach_messages_stamp before insert on outreach_messages for each row execute function outreach_trg_message_stamp();

-- first reply → per-step / per-variant "replied" counter
create or replace function outreach_trg_message_reply_stat() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare a outreach_actions%rowtype; seq uuid;
begin
  if new.is_first_reply and new.replied_to_action_id is not null then
    select * into a from outreach_actions where id = new.replied_to_action_id;
    select sequence_id into seq from outreach_enrollments where id = a.enrollment_id;
    if seq is not null and a.node_id is not null then
      insert into outreach_node_stats(sequence_id, node_id, variant_id, replied) values (seq, a.node_id, coalesce(a.variant_id,''), 1)
      on conflict (sequence_id, node_id, variant_id) do update set replied = outreach_node_stats.replied + 1, updated_at = now();
    end if;
  end if;
  return null;
end $$;
drop trigger if exists outreach_messages_reply_stat on outreach_messages;
create trigger outreach_messages_reply_stat after insert on outreach_messages for each row execute function outreach_trg_message_reply_stat();

-- node stats keyed by variant
create or replace function outreach_trg_action_stats() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare seq uuid; dq int := 0; ds int := 0; df int := 0; dk int := 0;
begin
  if coalesce(new.enrollment_id, old.enrollment_id) is null or coalesce(new.node_id, old.node_id) is null then return null; end if;
  if coalesce((coalesce(new.payload, old.payload)->>'prefetch')::boolean,false) or coalesce((coalesce(new.payload, old.payload)->>'subtask')::boolean,false) then return null; end if;
  select sequence_id into seq from outreach_enrollments where id = coalesce(new.enrollment_id, old.enrollment_id);
  if seq is null then return null; end if;
  if tg_op = 'INSERT' then
    if new.status in ('queued','reserved') then dq := 1; end if;
  elsif tg_op = 'UPDATE' then
    if old.status in ('queued','reserved') and new.status not in ('queued','reserved') then dq := -1; end if;
    if old.status not in ('queued','reserved') and new.status in ('queued','reserved') then dq := 1; end if;
    if new.status = 'sent' and old.status <> 'sent' then ds := 1; end if;
    if new.status = 'failed' and old.status <> 'failed' then df := 1; end if;
    if new.status = 'skipped' and old.status <> 'skipped' then dk := 1; end if;
  elsif tg_op = 'DELETE' then
    if old.status in ('queued','reserved') then dq := -1; end if;
  end if;
  if dq <> 0 or ds <> 0 or df <> 0 or dk <> 0 then
    insert into outreach_node_stats(sequence_id, node_id, variant_id, queued, sent, failed, skipped)
    values (seq, coalesce(new.node_id, old.node_id), coalesce(new.variant_id, old.variant_id, ''), greatest(dq,0), ds, df, dk)
    on conflict (sequence_id, node_id, variant_id) do update set
      queued = greatest(outreach_node_stats.queued + dq, 0), sent = outreach_node_stats.sent + ds,
      failed = outreach_node_stats.failed + df, skipped = outreach_node_stats.skipped + dk, updated_at = now();
  end if;
  return null;
end $$;

create or replace function outreach_trg_relation() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare r record; ws uuid;
begin
  if new.relation = 'first' and coalesce(old.relation::text,'none') <> 'first' then
    select workspace_id into ws from outreach_senders where id = new.sender_id;
    for r in select e.id, e.current_node_id, e.sequence_id from outreach_enrollments e
              where e.lead_id = new.lead_id and e.sender_id = new.sender_id and e.status = 'waiting_connection' loop
      insert into outreach_node_stats(sequence_id, node_id, variant_id, accepted) values (r.sequence_id, r.current_node_id, '', 1)
        on conflict (sequence_id, node_id, variant_id) do update set accepted = outreach_node_stats.accepted + 1, updated_at = now();
      perform outreach_advance_enrollment(r.id, r.current_node_id, 'connected', now() + interval '2 hours');
    end loop;
    if new.invite_sent_at is not null and old.relation = 'pending_out' then
      perform outreach_emit_event(ws, 'invite.accepted', jsonb_build_object('lead_id', new.lead_id, 'sender_id', new.sender_id, 'detected_at', coalesce(new.invite_detected_at, now())));
    end if;
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Tasks: call outcomes branch; reply_hold resumes or exits
-- -----------------------------------------------------------------------------
create or replace function outreach_complete_task(p_id uuid, p_text text default null, p_result jsonb default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare t outreach_tasks%rowtype; e outreach_enrollments%rowtype; g jsonb; n jsonb; atype outreach_action_type_t; payload jsonb; outcome text;
begin
  select * into t from outreach_tasks where id = p_id for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(t.workspace_id, 'member');
  if not outreach_client_visible(t.workspace_id, t.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if not outreach_client_visible(t.workspace_id, (select sq_.client_id from outreach_enrollments en_ join outreach_sequences sq_ on sq_.id = en_.sequence_id where en_.id = t.enrollment_id)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if t.completed_at is not null then return; end if;

  if t.kind = 'call' then
    outcome := coalesce(p_result->>'outcome', '');
    if outcome not in ('connected','voicemail','no_answer','wrong_number') then raise exception 'E_PAYLOAD_INVALID: outcome must be connected, voicemail, no_answer or wrong_number'; end if;
  end if;

  update outreach_tasks set completed_at = now(), completed_by = auth.uid(), result = coalesce(p_result, jsonb_build_object('text', p_text)),
    ai_draft = coalesce(p_text, ai_draft) where id = p_id;
  perform outreach_emit_event(t.workspace_id, 'task.completed', jsonb_build_object('id', p_id, 'kind', t.kind, 'lead_id', t.lead_id, 'result', p_result));

  if t.enrollment_id is null then return; end if;
  select * into e from outreach_enrollments where id = t.enrollment_id;
  if not found then return; end if;

  if t.kind = 'reply_hold' then
    if coalesce(p_result->>'decision','resume') = 'exit' then perform outreach_exit_enrollment(e.id, 'replied');
    else perform outreach_resume_enrollment(e.id); end if;
    return;
  end if;

  if e.status <> 'waiting_task' then return; end if;
  g := outreach_enrollment_graph(e.id);
  n := g->'nodes'->t.node_id;
  if n is null then perform outreach_advance_enrollment(e.id, t.node_id, null); return; end if;

  if t.kind = 'call' then
    update outreach_enrollments set status = 'active' where id = e.id;
    perform outreach_advance_enrollment(e.id, t.node_id, outcome);
    return;
  end if;

  if t.kind = 'review_ai_draft' then
    if coalesce(p_result->>'decision','approve') = 'reject' then
      update outreach_enrollments set status = 'active' where id = e.id;
      perform outreach_advance_enrollment(e.id, t.node_id, null);
      return;
    end if;
    atype := case coalesce(t.draft_kind, n->'config'->>'kind') when 'invite_note' then 'invite'::outreach_action_type_t when 'comment' then 'comment' else 'message' end;
    if (n->>'type') = 'ai_draft_approval' then
      payload := jsonb_build_object('text', coalesce(p_text, t.ai_draft), 'approved_task_id', p_id, 'approved_by', auth.uid(), 'kind', coalesce(t.draft_kind, n->'config'->>'kind'));
    else
      atype := outreach_node_action_type(n->>'type');
      payload := jsonb_build_object('text', coalesce(p_text, t.ai_draft), 'approved_task_id', p_id, 'approved_by', auth.uid());
    end if;
    update outreach_enrollments set status = 'active', wait_until = now() where id = e.id;
    perform outreach_queue_action(e.id, t.node_id, atype, now(), payload);
    return;
  end if;

  if t.kind = 'manual_node' then
    if outreach_is_executable_node(n->>'type') then
      atype := outreach_node_action_type(n->>'type');
      payload := outreach_node_config_for(e.id, n) || jsonb_build_object('approved_task_id', p_id) || case when p_text is not null then jsonb_build_object('text', p_text) else '{}'::jsonb end;
      update outreach_enrollments set status = 'active', wait_until = now() where id = e.id;
      perform outreach_queue_action(e.id, t.node_id, atype, now(), payload);
    else
      update outreach_enrollments set status = 'active' where id = e.id;
      perform outreach_advance_enrollment(e.id, t.node_id, null);
    end if;
  end if;
end $$;

-- housekeeping grants
do $$
declare f text;
begin
  for f in select unnest(array[
    'outreach_enter_node(uuid,text,timestamptz)','outreach_advance_enrollment(uuid,text,text,timestamptz)','outreach_release_waits()',
    'outreach_plan_budgets(uuid,date)','outreach_claim_due_actions(int)','outreach_create_node_task(outreach_enrollments,jsonb,outreach_task_kind_t)',
    'outreach_inmail_guard(uuid,date)']) loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function outreach_pick_variant(uuid,text,jsonb) to authenticated, service_role;
grant execute on function outreach_spintax_info(text) to authenticated, service_role;
