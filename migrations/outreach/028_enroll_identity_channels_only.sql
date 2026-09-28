-- Enrolment: only Instagram and WhatsApp senders need a handle / number on file for the lead (plus an upload policy, below).
-- 026 asked every pool sender for a channel identity, but outreach_lead_identity() only knows LinkedIn, Instagram and
-- WhatsApp, so a sequence sent from a Gmail / Outlook / IMAP mailbox left every lead out with "no Instagram handle /
-- WhatsApp number". The send step (execute.ts) already checks identities for Instagram / WhatsApp only; the plan now
-- does the same. The reason also names the channel (no_identity:instagram | no_identity:whatsapp) so the app can say
-- which one is missing; plain no_identity stays for a pool that mixes both.
-- Patches the live definition in place so nothing else in the function changes.
do $$
declare def text := pg_get_functiondef('public.outreach__enroll_plan(uuid,uuid[],uuid,boolean)'::regprocedure);
        old_fit text := $q$select coalesce(array_agg(x), '{}') into fit from unnest(free) x where outreach_lead_identity(lid, (prov->>x::text)::outreach_provider_t) is not null;
    if array_length(fit,1) is null then reason := 'no_identity'; return next; continue; end if;$q$;
        new_fit text := $q$select coalesce(array_agg(x), '{}') into fit from unnest(free) x
     where (prov->>x::text) not in ('INSTAGRAM','WHATSAPP') or outreach_lead_identity(lid, (prov->>x::text)::outreach_provider_t) is not null;
    if array_length(fit,1) is null then
      reason := case when (select count(distinct prov->>y::text) from unnest(free) y) = 1 then 'no_identity:' || lower(prov->>free[1]::text) else 'no_identity' end;
      return next; continue;
    end if;$q$;
begin
  if position('not in (''INSTAGRAM'',''WHATSAPP'')' in def) > 0 then return; end if;   -- already applied
  if position(old_fit in def) = 0 then raise exception 'outreach__enroll_plan: identity check not found, patch not applied'; end if;
  execute replace(def, old_fit, new_fit);
end $$;
revoke execute on function outreach__enroll_plan(uuid,uuid[],uuid,boolean) from public, anon, authenticated;

-- Uploads to outreach-attachments by workspace members. Only <ws>/voice/... had an insert policy (015), so the inbox
-- composer's files (<ws>/<chat>/...) and the email step's files (<ws>/sequence-files/<sequence>/<node>/...) were refused.
-- Reads stay on outreach_imports_read (003); the engine reads with the service role.
drop policy if exists outreach_attachments_upload on storage.objects;
create policy outreach_attachments_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'outreach-attachments'
              and (storage.foldername(name))[1] in (select id::text from outreach_workspaces where id in (select outreach_workspace_ids())));

-- Messages stored from the messaging webhook before its attachment_* fields were read have attachments without an id
-- (the inbox could not open those threads). Rebuild them from the raw event when it is still kept; the voice-note flag
-- follows attachment_type audio, and a shared Instagram post keeps its link.
update outreach_messages m set attachments = x.atts
  from (
    select m2.id,
           (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                     'id', a->>'attachment_id', 'type', a->>'attachment_type', 'name', a->>'attachment_name',
                     'size', case when jsonb_typeof(a->'attachment_size') = 'number' then a->'attachment_size' end,
                     'unipile_message_id', m2.unipile_message_id,
                     'unavailable', case when (a->>'attachment_unavailable') = 'true' then true end,
                     'voice_note', case when lower(coalesce(a->>'attachment_type','')) = 'audio' then true end,
                     'link', case when coalesce(a->'post'->>'url', a->'cta'->>'url') is not null
                                  then jsonb_strip_nulls(jsonb_build_object('url', coalesce(a->'post'->>'url', a->'cta'->>'url'), 'author', a->'post'->>'author')) end))
                   order by t.ord)
              from jsonb_array_elements(e.payload->'attachments') with ordinality t(a, ord)) atts
      from outreach_messages m2
      join lateral (select ev.payload from outreach_inbound_events ev
                     where ev.payload->>'message_id' = m2.unipile_message_id and jsonb_typeof(ev.payload->'attachments') = 'array'
                     order by ev.received_at desc limit 1) e on true
     where m2.unipile_message_id is not null
       and exists (select 1 from jsonb_array_elements(coalesce(m2.attachments, '[]'::jsonb)) z where z->>'id' is null)
  ) x
 where m.id = x.id and x.atts is not null;
