-- 020: context-aware sequence builder (Fix 14, Sept 2026).
-- A message after an "Already connected?" condition (rule relation = first on its true branch, or relation <> first /
-- accepted = false on its false branch) is a valid message path: the lead is proven to be a connection, so the strict
-- validation no longer demands an invite / wait / InMail before it. Mirrors provesConnection() in lib/outreach/graph.ts.
-- Idempotent: re-creates outreach_validate_graph from 011 with the one extra check.

create or replace function outreach_condition_proves_connection(p_node jsonb) returns boolean
language plpgsql immutable as $$
declare
  rules jsonb := p_node->'config'->'rules'; r jsonb; all_match boolean; n int; f text; v text; op text;
  fact_true text := null; fact_false text := null; ft text; ff text; ok_true boolean; ok_false boolean; contradict_t boolean := false; contradict_f boolean := false;
begin
  if rules is null or jsonb_typeof(rules) <> 'array' then return false; end if;
  n := jsonb_array_length(rules);
  if n = 0 then return false; end if;
  all_match := coalesce(p_node->'config'->>'match','all') <> 'any';
  -- true exit under "match all" (or one rule): every rule holds; false exit under "match any" (or one rule): every rule fails
  ok_true := all_match or n = 1;
  ok_false := (not all_match) or n = 1;
  for r in select * from jsonb_array_elements(rules) loop
    f := r->>'field'; op := r->>'op'; v := coalesce(r->>'value','');
    ft := null; ff := null;
    if f = 'relation' then
      if op = 'eq' and v = 'first' then ft := 'connected'; ff := 'not_connected';
      elsif op = 'neq' and v = 'first' then ft := 'not_connected'; ff := 'connected';
      elsif op = 'eq' then ft := 'not_connected';
      elsif op = 'neq' then ff := 'not_connected';
      end if;
    elsif f = 'accepted' and op = 'eq' then
      if v = 'true' then ft := 'connected'; else ff := 'connected'; end if;
    end if;
    if ft is not null then
      if fact_true is not null and fact_true <> ft then contradict_t := true; end if;
      fact_true := ft;
    end if;
    if ff is not null then
      if fact_false is not null and fact_false <> ff then contradict_f := true; end if;
      fact_false := ff;
    end if;
  end loop;
  return coalesce(ok_true and not contradict_t and fact_true = 'connected', false) or coalesce(ok_false and not contradict_f and fact_false = 'connected', false);
end $$;

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
    -- an "Already connected?" check whose branch proves the lead is a connection is a message path too
    if t = 'condition' and outreach_condition_proves_connection(n) then has_connect_path := true; end if;

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
