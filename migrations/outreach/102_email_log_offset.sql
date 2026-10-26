-- 102: the email log pages server-side like the other tables (Settings → Email & booking → Email log).
-- outreach_email_log_search gains p_offset; the old 7-argument signature is dropped so PostgREST sees one function.
drop function if exists outreach_email_log_search(uuid, text, text, text, timestamptz, timestamptz, int);

create or replace function outreach_email_log_search(p_ws uuid, p_to text default null, p_type text default null, p_status text default null,
                                                     p_since timestamptz default null, p_until timestamptz default null, p_limit int default 50,
                                                     p_offset int default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare rows jsonb; total int; lim int := greatest(1, least(coalesce(p_limit, 50), 500)); off int := greatest(0, coalesce(p_offset, 0));
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
           order by l.sent_at desc limit lim offset off) l
    left join outreach_sending_domains d on d.id = l.sending_domain_id;
  return jsonb_build_object('total', total, 'rows', rows, 'limit', lim, 'offset', off);
end $$;
grant execute on function outreach_email_log_search(uuid, text, text, text, timestamptz, timestamptz, int, int) to authenticated;
revoke execute on function outreach_email_log_search(uuid, text, text, text, timestamptz, timestamptz, int, int) from public, anon;
