-- 092 — Account labels for every sender a workspace ever had, removed ones included.
--
-- Why: the inbox shows which account a conversation runs through ("Aarushi Jain" next to a LinkedIn chat). The list
-- read that name through the outreach_senders join, and senders_select hides deleted rows, so a chat on a removed
-- account (every WhatsApp sender in some workspaces) showed no account at all: nobody could tell whose WhatsApp,
-- Instagram or mailbox received the message. This function returns the label fields only (no tokens, no settings)
-- for every sender of the workspace, with a `removed` flag, so the inbox can name the account in every channel.
-- Client-scoped members still only see the senders of their clients.

create or replace function outreach_sender_labels(p_workspace uuid)
returns table (id uuid, provider outreach_provider_t, display_name text, public_identifier text, owner_email text, picture_url text, removed boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_workspace, 'client_viewer');
  return query
    select s.id, s.provider, s.display_name, s.public_identifier, s.owner_email::text, s.picture_url, (s.deleted_at is not null) as removed
      from outreach_senders s
     where s.workspace_id = p_workspace
       and outreach_client_visible(s.workspace_id, s.client_id)
     order by s.created_at;
end $$;

revoke all on function outreach_sender_labels(uuid) from public, anon;
grant execute on function outreach_sender_labels(uuid) to authenticated, service_role;
