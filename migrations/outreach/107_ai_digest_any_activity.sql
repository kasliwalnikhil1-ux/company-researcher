-- =============================================================================
-- 107 — AI replies daily summary: send it on any day something happened (6 Nov 2026).
--
-- outreach_ai_reply_digest_data('manager', since) decides which workspaces get the "AI replies: daily summary" email.
-- Until now a workspace was listed only when a reply went out on Auto, was handed to a person, was cancelled by a
-- teammate, or a conversation was handed off. A day whose only activity was AI drafts sent by the team, or messages
-- that needed no reply, sent nothing, although the email has a line for both.
--
-- Now any of the six numbers the email shows is enough. A workspace with no AI reply activity still gets no email,
-- so an all-zero summary is never sent. The 'owner' branch and the row shape are unchanged from 041.
-- =============================================================================

create or replace function outreach_ai_reply_digest_data(p_kind text, p_since timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_kind = 'owner' then
    return coalesce((select jsonb_agg(jsonb_build_object('sender_id', s.id, 'workspace_id', s.workspace_id, 'sender_name', s.display_name, 'owner_email', s.owner_email,
      'sequences', (select jsonb_agg(distinct q.name) from outreach_ai_reply_runs r join outreach_sequences q on q.id = r.sequence_id where r.sender_id = s.id and r.status = 'sent' and r.sent_origin = 'ai_autopilot' and r.updated_at >= p_since),
      'items', (select jsonb_agg(jsonb_build_object('chat_id', r.chat_id, 'lead', coalesce(l.full_name, c.attendee_name), 'text', r.final_text, 'sent_at', r.timings->>'sent_at') order by r.updated_at)
                  from outreach_ai_reply_runs r join outreach_chats c on c.id = r.chat_id left join outreach_leads l on l.id = c.lead_id
                 where r.sender_id = s.id and r.status = 'sent' and r.sent_origin = 'ai_autopilot' and r.updated_at >= p_since)))
      from outreach_senders s
     where s.owner_email is not null and s.deleted_at is null
       and exists (select 1 from outreach_ai_reply_runs r where r.sender_id = s.id and r.status = 'sent' and r.sent_origin = 'ai_autopilot' and r.updated_at >= p_since)), '[]'::jsonb);
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('workspace_id', w.workspace_id,
      'sent_ai', w.sent_ai, 'sent_draft', w.sent_draft, 'escalated', w.escalated, 'cancelled', w.cancelled, 'no_reply', w.no_reply, 'handed_off', w.handed_off,
      'reasons', (select jsonb_agg(jsonb_build_object('reason', k.reason, 'n', k.n)) from (
                    select coalesce(r.cancel_reason, r.escalation_reasons[1]) reason, count(*) n from outreach_ai_reply_runs r
                     where r.workspace_id = w.workspace_id and r.updated_at >= p_since and r.status in ('cancelled','escalated')
                       and coalesce(r.cancel_reason, '') not in ('human_takeover','superseded','taken_manual','handed_off') group by 1 order by 2 desc limit 8) k),
      'downgrades', (select jsonb_agg(jsonb_build_object('sequence_id', p.sequence_id, 'reason', p.downgrade_reason)) from outreach_sequence_reply_settings p
                      where p.workspace_id = w.workspace_id and p.downgraded_at >= p_since)))
    from (select r.workspace_id,
                 count(*) filter (where r.status = 'sent' and r.sent_origin = 'ai_autopilot') sent_ai,
                 count(*) filter (where r.status = 'sent' and r.sent_origin in ('ai_draft_sent','ai_edited')) sent_draft,
                 count(*) filter (where r.status = 'escalated') escalated,
                 count(*) filter (where r.status = 'cancelled' and r.cancelled_by is not null) cancelled,
                 count(*) filter (where r.status = 'no_reply') no_reply,
                 (select count(*) from outreach_chats c where c.workspace_id = r.workspace_id and c.ai_handed_off_at >= p_since) handed_off
            from outreach_ai_reply_runs r where r.updated_at >= p_since group by r.workspace_id) w
   where w.sent_ai + w.sent_draft + w.escalated + w.cancelled + w.no_reply + w.handed_off > 0), '[]'::jsonb);
end $$;
