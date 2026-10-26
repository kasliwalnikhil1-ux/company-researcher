-- 088 — Where the hosted sign-in lands when its placeholder sender was folded into an existing one.
--
-- Why: "Connect an account" creates a placeholder sender and the sign-in page comes back to /outreach/senders/<placeholder>.
-- When the account that signed in is already a sender in the workspace, the webhook folds the placeholder into that
-- sender and leaves a tombstone (deleted_at set, status_reason 'merged_into:<survivor>') for the redirect to follow.
-- But senders_select hides every deleted row, so the page's single-row read found nothing and showed PostgREST's
-- "Cannot coerce the result to a single JSON object". This function follows the tombstone chain for a workspace member
-- and returns the sender to open (the row itself when it is visible, the survivor when it was merged, null otherwise).
-- The page reads the survivor through RLS as usual, so nothing hidden becomes readable.

create or replace function outreach_sender_landing(p_sender uuid) returns uuid
language plpgsql stable security definer set search_path = public, extensions as $$
declare s record; cur uuid := p_sender; hops int := 0;
begin
  if cur is null then return null; end if;
  loop
    select id, workspace_id, client_id, deleted_at, status_reason into s from outreach_senders where id = cur;
    if s.id is null then return null; end if;
    if not outreach_is_service() then
      if s.workspace_id not in (select outreach_workspace_ids()) then return null; end if;
    end if;
    if s.deleted_at is null then
      if not outreach_is_service() and not outreach_client_visible(s.workspace_id, s.client_id) then return null; end if;
      return s.id;
    end if;
    -- a merged tombstone points at the sender that took over the account; follow it (a few hops at most)
    if s.status_reason ~ '^merged_into:[0-9a-fA-F-]{36}$' and hops < 5 then
      cur := substr(s.status_reason, 13)::uuid; hops := hops + 1;
    else
      return null;
    end if;
  end loop;
end $$;

revoke all on function outreach_sender_landing(uuid) from public, anon;
grant execute on function outreach_sender_landing(uuid) to authenticated, service_role;
