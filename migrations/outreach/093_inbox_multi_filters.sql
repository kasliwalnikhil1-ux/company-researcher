-- 093 — Inbox filters: several senders / channels at once, and a reply-date range.
--
-- Why: the inbox's Sender, Reply intent, Channel, AI replies and Stage filters are multi-select, and a new Reply date
-- filter narrows the list to conversations whose latest reply from the other person (last_inbound_at) fell in a range.
--   1. outreach_inbox_counts (the Needs reply chip) takes `sender_ids` and `providers` lists beside the older single
--      `sender_id` / `provider`, so the count follows the same filters as the list.
--   2. An index on (workspace_id, last_inbound_at desc, id desc) for the replied conversations, so a narrow or old reply
--      date range is found by range scan instead of walking the whole (workspace_id, last_message_at) order.
-- The list itself reads outreach_chats through PostgREST: one value = `eq`, several = `in`, both on the same columns
-- and indexes as before (outreach_chats_replies_idx / outreach_chats_needs_reply_idx from 075).

-- ============================================================================= 1. counts with lists
create or replace function outreach_inbox_counts(p_ws uuid, p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare f jsonb := coalesce(p_filters, '{}'::jsonb); v_assigned uuid; v_client uuid; v_senders uuid[]; v_providers text[];
        unread int; needs int; sched int := 0; failed int := 0; since timestamptz := now() - interval '7 days';
begin
  perform outreach_require(p_ws, 'client_viewer');
  begin
    v_assigned := nullif(f ->> 'assigned_to', '')::uuid; v_client := nullif(f ->> 'client_id', '')::uuid;
    -- a list wins over the single key; an empty list means every sender / channel
    select array_agg(x::uuid) into v_senders from jsonb_array_elements_text(case when jsonb_typeof(f -> 'sender_ids') = 'array' then f -> 'sender_ids' else '[]'::jsonb end) x where x <> '';
    if v_senders is null and nullif(f ->> 'sender_id', '') is not null then v_senders := array[(f ->> 'sender_id')::uuid]; end if;
    select array_agg(x) into v_providers from jsonb_array_elements_text(case when jsonb_typeof(f -> 'providers') = 'array' then f -> 'providers' else '[]'::jsonb end) x where x <> '';
    if v_providers is null and nullif(f ->> 'provider', '') is not null then v_providers := array[f ->> 'provider']; end if;
  exception when others then raise exception 'E_PAYLOAD_INVALID: filters'; end;

  select count(*) into unread from outreach_chats c
   where c.workspace_id = p_ws and c.unread and not c.archived and outreach_client_visible(p_ws, c.client_id);
  select count(*) into needs from outreach_chats c
   where c.workspace_id = p_ws and c.waiting_on = 'us' and c.archived = false and coalesce(c.status, 'open') not in ('resolved', 'snoozed')
     and not c.ai_answering and outreach_client_visible(p_ws, c.client_id)
     and (v_assigned is null or c.assigned_to = v_assigned) and (v_senders is null or c.sender_id = any(v_senders))
     and (v_client is null or c.client_id = v_client) and (v_providers is null or c.provider::text = any(v_providers));
  if outreach__sent_allowed(p_ws) then
    select count(*) into sched from outreach_sent_items v
     where v.workspace_id = p_ws and v.src in ('queued', 'ai_hold') and outreach_client_visible(p_ws, v.client_id);
    select count(*) into failed from outreach_sent_items v
      left join outreach_enrollments e on e.id = v.enrollment_id
      left join outreach_leads l on l.id = v.lead_id
      left join outreach_chats c on c.id = v.chat_id
     where v.workspace_id = p_ws and v.src in ('failed', 'bounce') and v.at >= since and outreach_client_visible(p_ws, v.client_id)
       and case when v.src = 'bounce' then l.id is null or (not coalesce(l.do_not_contact, false)
                       and lower(coalesce(c.attendee_provider_id, '')) in (lower(coalesce(l.email_work::text, '')), lower(coalesce(l.email_personal::text, ''))))
                else v.enrollment_id is null or e.status = 'failed' end;
  end if;
  return jsonb_build_object('replies_unread', unread, 'needs_reply', needs, 'scheduled', sched, 'failed', failed, 'show_sent', outreach__sent_allowed(p_ws));
end $$;

revoke execute on function outreach_inbox_counts(uuid, jsonb) from public, anon;
grant execute on function outreach_inbox_counts(uuid, jsonb) to authenticated, service_role;

-- ============================================================================= 2. reply-date index
create index if not exists outreach_chats_last_inbound_idx on outreach_chats (workspace_id, last_inbound_at desc, id desc)
  where last_inbound_at is not null and archived = false;
