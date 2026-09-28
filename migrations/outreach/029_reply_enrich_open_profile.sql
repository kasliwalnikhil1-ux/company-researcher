-- 029 — LinkedIn fixes (Sept 2026)
--
-- Fix 1: fetch the lead's profile details on their FIRST reply.
--   The messaging webhook (inbound.ts handleMessaging) marks the reply, exits enrollments and queues ai_classify. It now also
--   calls outreach_enrich_on_reply() for the first inbound message of a LinkedIn conversation. The lead is queued for the
--   background enrichment worker when it is missing company / location / work email or was never enriched, and the
--   workspace setting `enrich_on_reply` is not off (default on).
--   Budget: the fetch is the same GET /users/{id}?linkedin_sections=… call as everywhere else, so it spends one profile_view
--   from the REPLYING sender (100/day ceiling). It goes through outreach-worker-enrich, i.e. only profile views left over after
--   the day's planned sequence work (Visit Profile / prefetch actions are subtracted first), inside the 30% background share,
--   never at warm-up level 0–1. Reply rows go to the front of that background line. Bursty reply volume therefore cannot eat
--   the views a sequence has planned; at worst a reply lead waits for the next day's leftover.
--   The queue row is pinned to the replying sender for 24 hours (a 1st-degree connection shows contact info to that sender
--   only), then any sender of the workspace may take it.
--
-- Fix 2: Open Profile leads skip the invitation.
--   "Send invitation" gets an optional `open_profile` exit (builder switch config.open_profile_inmail). When it is wired and the
--   lead is an Open Profile (leads.is_open_profile, set by any profile read), the lead goes straight down that exit — normally to
--   "Send InMail", which is free for Open Profiles — and no invitation is sent or reserved.
--   Three places route, so no invite budget is ever held for such a lead:
--     a) outreach_enter_node: the lead is already known to be an Open Profile when it reaches the step;
--     b) outreach_complete_action: the profile prefetch before the invitation just found out (the queued invite is skipped);
--     c) execute.ts: safety net at send time (the reserved invite is released by outreach_fail_action's branch path).
--   InMail keeps its own ledger row (action_type 'inmail'): it never counts against the invitation cap (80/day, 150/week) or the
--   message cap (100/day). Its ceiling stays 50/day with warm-up 0/5/10/20/30/40 and the speed guard (outreach_inmail_guard),
--   inside the 30–50/day per sender Unipile recommends even though Open Profile InMails cost no credits.
--
-- Idempotent. Live function bodies are patched in place (like 027 / 028) so nothing else in them changes.

-- ----------------------------------------------------------------------------- Fix 1
alter table outreach_enrich_queue add column if not exists sender_id uuid references outreach_senders(id) on delete set null;
comment on column outreach_enrich_queue.sender_id is 'Preferred sender (reason = reply: the sender the lead replied to). Other senders may take the row after 24 hours.';
comment on column outreach_enrich_queue.reason is 'manual | import | setting | re_enrich | enrollment | reply';

-- queue a replying lead for enrichment; returns what happened (queued | disabled | not_linkedin | no_lead | do_not_contact |
-- no_linkedin_id | complete | fresh). Service only: called by the messaging webhook.
create or replace function outreach_enrich_on_reply(p_lead uuid, p_sender uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; l outreach_leads%rowtype; ws jsonb; enriched timestamptz;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_senders where id = p_sender;
  if not found or s.provider <> 'LINKEDIN' then return 'not_linkedin'; end if;
  select * into l from outreach_leads where id = p_lead;
  if not found or l.workspace_id <> s.workspace_id then return 'no_lead'; end if;
  select settings into ws from outreach_workspaces where id = s.workspace_id;
  if coalesce(ws->>'enrich_on_reply', 'true') = 'false' then return 'disabled'; end if;
  if l.do_not_contact then return 'do_not_contact'; end if;
  if l.public_identifier is null and l.provider_id is null then return 'no_linkedin_id'; end if;
  select p.enriched_at into enriched from outreach_lead_profiles p where p.lead_id = p_lead;
  if enriched is not null and l.company is not null and l.location is not null and l.email_work is not null then return 'complete'; end if;
  -- read in the last 24 hours (e.g. by the message step that got this reply): that read already stored what LinkedIn shows
  if enriched is not null and l.last_profile_fetch_at > now() - interval '24 hours' then return 'fresh'; end if;
  insert into outreach_enrich_queue(lead_id, workspace_id, want_posts, requested_by, reason, sender_id)
  values (p_lead, s.workspace_id, false, null, 'reply', p_sender)
  on conflict (lead_id) do update set reason = 'reply', sender_id = excluded.sender_id, attempts = 0,
    next_at = least(outreach_enrich_queue.next_at, now());
  update outreach_leads set enrich_status = 'waiting' where id = p_lead and enrich_status <> 'waiting';
  return 'queued';
end $$;
revoke execute on function outreach_enrich_on_reply(uuid,uuid) from public, anon, authenticated;

-- 014 + reply rows first in the background line, pinned to their sender for 24 hours
create or replace function outreach_enrich_next(p_sender uuid, p_limit int)
returns table(lead_id uuid, want_posts boolean, priority boolean, provider_id text, public_identifier text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_senders where id = p_sender;
  return query
    (select l.id, coalesce(q.want_posts, false), true, l.provider_id, l.public_identifier::text
       from outreach_enrollments e join outreach_leads l on l.id = e.lead_id left join outreach_enrich_queue q on q.lead_id = l.id
      where e.sender_id = p_sender and e.status = 'waiting_task' and e.wait_reason = 'enrichment' and coalesce(q.attempts, 0) < 3 and coalesce(q.next_at, now()) <= now()
      order by e.priority, e.created_at limit p_limit)
    union all
    (select l.id, q.want_posts, false, l.provider_id, l.public_identifier::text
       from outreach_enrich_queue q join outreach_leads l on l.id = q.lead_id
      where q.workspace_id = s.workspace_id and q.next_at <= now() and q.attempts < 3 and (l.client_id is null or s.client_id is null or l.client_id = s.client_id)
        and (q.sender_id is null or q.sender_id = p_sender or q.created_at < now() - interval '24 hours')
        and not exists (select 1 from outreach_enrollments e where e.lead_id = l.id and e.status = 'waiting_task' and e.wait_reason = 'enrichment')
      order by (q.reason = 'reply') desc, q.created_at limit p_limit);
end $$;
revoke execute on function outreach_enrich_next(uuid,int) from public, anon, authenticated;

-- ----------------------------------------------------------------------------- Fix 2
-- Where an Open Profile lead goes instead of the invitation: the step's `open_profile` exit, when it is wired, the sender is
-- LinkedIn, the lead is an Open Profile and not already connected / invited (those keep the step's usual handling).
create or replace function outreach__open_profile_target(p_enrollment uuid, p_node jsonb) returns text
language plpgsql stable security definer set search_path = public, extensions as $$
declare e outreach_enrollments%rowtype; tgt text; prov outreach_provider_t; op boolean; rel outreach_relation_t;
begin
  if coalesce(p_node->>'type', '') <> 'send_invite' then return null; end if;
  tgt := nullif(p_node->'branches'->>'open_profile', '');
  if tgt is null then return null; end if;
  select * into e from outreach_enrollments where id = p_enrollment;
  if not found then return null; end if;
  select provider into prov from outreach_senders where id = e.sender_id;
  if prov is distinct from 'LINKEDIN' then return null; end if;
  select is_open_profile into op from outreach_leads where id = e.lead_id;
  if op is not true then return null; end if;
  select relation into rel from outreach_lead_sender_state where lead_id = e.lead_id and sender_id = e.sender_id;
  if rel in ('first', 'pending_out', 'invalid', 'blocked') then return null; end if;
  return tgt;
end $$;
revoke execute on function outreach__open_profile_target(uuid,jsonb) from public, anon, authenticated;

-- After the profile prefetch of an invitation step: an Open Profile lead leaves by the `open_profile` exit and the queued
-- invitation (and anything else still queued for that step) is dropped before it ever reserves a budget.
create or replace function outreach__open_profile_reroute(p_enrollment uuid, p_node_id text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare e outreach_enrollments%rowtype; tgt text;
begin
  select * into e from outreach_enrollments where id = p_enrollment for update;
  if not found or e.current_node_id is distinct from p_node_id or e.status not in ('active', 'waiting_delay') then return false; end if;
  tgt := outreach__open_profile_target(e.id, outreach_enrollment_graph(e.id)->'nodes'->p_node_id);
  if tgt is null then return false; end if;
  -- an invitation already being sent is the executor's to route (it branches the same way and releases the reservation)
  if exists (select 1 from outreach_actions a where a.enrollment_id = e.id and a.node_id = p_node_id and a.status = 'reserved') then return false; end if;
  update outreach_actions set status = 'skipped', executed_at = now(), error_code = 'open_profile', decision = 'branch:open_profile'
   where enrollment_id = e.id and node_id = p_node_id and status = 'queued' and action_type = 'invite';
  update outreach_actions set status = 'cancelled', error_code = 'open_profile', decision = 'cancel'
   where enrollment_id = e.id and node_id = p_node_id and status = 'queued';
  perform outreach_emit_event(e.workspace_id, 'enrollment.open_profile', jsonb_build_object('enrollment_id', e.id, 'lead_id', e.lead_id, 'sender_id', e.sender_id, 'node_id', p_node_id, 'next', tgt));
  perform outreach_advance_enrollment(e.id, p_node_id, 'open_profile');
  return true;
end $$;
revoke execute on function outreach__open_profile_reroute(uuid,text) from public, anon, authenticated;

-- a) entering the step
do $$
declare def text := pg_get_functiondef('public.outreach_enter_node(uuid,text,timestamptz)'::regprocedure);
        old_s text := $q$    elsif outreach_is_executable_node(t) then
      if n ? 'delay' and (n->'delay'->>'amount') is not null then$q$;
        new_s text := $q$    elsif outreach_is_executable_node(t) then
      -- 029: an Open Profile lead on an invitation step with the `open_profile` exit wired skips the invitation
      branch := case when t = 'send_invite' then outreach__open_profile_target(e.id, n) end;
      if branch is not null then
        perform outreach_emit_event(e.workspace_id, 'enrollment.open_profile', jsonb_build_object('enrollment_id', e.id, 'lead_id', e.lead_id, 'sender_id', e.sender_id, 'node_id', nid, 'next', branch));
        nid := branch; continue;
      end if;
      if n ? 'delay' and (n->'delay'->>'amount') is not null then$q$;
begin
  if position('outreach__open_profile_target' in def) > 0 then return; end if;
  if position(old_s in def) = 0 then raise exception 'outreach_enter_node: executable-step branch not found, patch not applied'; end if;
  execute replace(def, old_s, new_s);
end $$;

-- b) the prefetch before the invitation found out
do $$
declare def text := pg_get_functiondef('public.outreach_complete_action(uuid,jsonb,text)'::regprocedure);
        old_s text := $q$    perform outreach_advance_enrollment(a.enrollment_id, a.node_id, p_branch);
  end if;$q$;
        new_s text := $q$    perform outreach_advance_enrollment(a.enrollment_id, a.node_id, p_branch);
  elsif a.enrollment_id is not null and a.action_type = 'profile_view' and coalesce((a.payload->>'prefetch')::boolean, false) then
    -- 029: the profile read before an invitation may show an Open Profile: route it past the invitation now
    perform outreach__open_profile_reroute(a.enrollment_id, a.node_id);
  end if;$q$;
begin
  if position('outreach__open_profile_reroute' in def) > 0 then return; end if;
  if position(old_s in def) = 0 then raise exception 'outreach_complete_action: advance call not found, patch not applied'; end if;
  execute replace(def, old_s, new_s);
end $$;

-- the reason shown on the skipped invitation
do $$
declare def text := pg_get_functiondef('public.outreach_reason_text(text,text)'::regprocedure);
        old_s text := $q$    when p_code = 'no_chat' then$q$;
        new_s text := $q$    when p_code = 'open_profile' then 'Open Profile: the lead got an InMail instead of an invitation'
    when p_code = 'no_chat' then$q$;
begin
  if position('''open_profile''' in def) > 0 then return; end if;
  if position(old_s in def) = 0 then raise exception 'outreach_reason_text: anchor not found, patch not applied'; end if;
  execute replace(def, old_s, new_s);
end $$;
