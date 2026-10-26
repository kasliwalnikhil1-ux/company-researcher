-- 104: delete a sequence in any status (product decision 26 Oct 2026). Before this, the RLS delete policy only let a
-- manager delete a draft or archived sequence, so an active or paused one had to be archived first.
--
--   * `outreach_delete_sequence(p_id, p_confirm)`: p_confirm must be the sequence's name (trimmed, case-insensitive),
--     the same type-the-name check as erasing a sender, so the API and agents can't delete by id alone.
--   * Leads still in it leave first through the normal exit path (exited_manual / sequence_deleted): queued actions are
--     cancelled and `enrollment.exited` webhooks go out. Then the row is deleted and the foreign keys cascade as before
--     (versions, enrolments with their actions and tasks, stats, auto-enrol rules, voice clips).
--   * The leads it touched get their summary rebuilt (status ladder, "In sequence") since their enrolments are gone.
--   * The old RLS delete policy stays as it is (drafts / archived) for the template picker's rollback; the app calls the RPC.

create or replace function outreach_delete_sequence(p_id uuid, p_confirm text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; r record; exited int := 0; leads uuid[]; lid uuid;
begin
  perform outreach__sequence_access(p_id, 'manager');
  select * into s from outreach_sequences where id = p_id for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if lower(btrim(coalesce(p_confirm, ''))) <> lower(btrim(s.name)) then
    raise exception 'E_PAYLOAD_INVALID: type the sequence name to confirm';
  end if;

  select coalesce(array_agg(distinct lead_id), '{}') into leads from outreach_enrollments where sequence_id = p_id;

  for r in select id from outreach_enrollments where sequence_id = p_id and status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
    perform outreach_complete_enrollment(r.id, 'exited_manual', 'sequence_deleted');
    exited := exited + 1;
  end loop;

  delete from outreach_sequences where id = p_id;

  foreach lid in array leads loop perform outreach_lead_summary_enqueue(lid); end loop;
  perform outreach_audit(s.workspace_id, 'sequence.deleted', 'sequence', p_id::text,
    jsonb_build_object('name', s.name, 'status', s.status, 'leads', cardinality(leads), 'exited', exited));
  return jsonb_build_object('deleted', true, 'status', s.status, 'leads', cardinality(leads), 'exited', exited);
end $$;
revoke execute on function outreach_delete_sequence(uuid, text) from public, anon;
grant execute on function outreach_delete_sequence(uuid, text) to authenticated;
