-- =============================================================================
-- Outreach Platform — 026 Instagram & WhatsApp channels: functions
-- Source: docs/outreach/CHANNELS-BUILD-CONTRACT.md §3 (instagram-whatsapp-channels-PRD.md, 25 Sep 2026).
-- Requires 024 + 025. Idempotent. Every user-facing function: outreach_require() then outreach_client_visible().
--
-- Rules kept from the platform: safety stays in the database. Every provider call reserves a budget first; the new
-- hourly / daily "all actions" scopes are extra rows the same reservation must also win. Mail providers keep the
-- LINKEDIN ceiling table (outreach__ceiling_provider), so no existing allowance changes. LinkedIn numbers are identical
-- to 011 for every existing type; the only LinkedIn addition is `new_chat` (= message).
--
-- Sections: helpers · identity · consent · ledger · claim/complete/fail · node catalogue · engine (enter_node, waits,
-- triggers, planner) · enrolment · validator · reasons / causes / why-not-sending · health / senders / governor ·
-- reports · leads (upsert) · cron · grants.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helpers (internal: revoked from signed-in users in the footer)
-- -----------------------------------------------------------------------------
-- reporting channel of a provider: linkedin | instagram | whatsapp | email (null → linkedin, for rows with no sender)
create or replace function outreach__channel_of(p outreach_provider_t) returns text
language sql immutable as $$
  select case when p is null then 'linkedin' when p in ('LINKEDIN','INSTAGRAM','WHATSAPP') then lower(p::text) else 'email' end
$$;

create or replace function outreach__provider_label(p outreach_provider_t) returns text
language sql immutable as $$
  select case p when 'LINKEDIN' then 'LinkedIn' when 'INSTAGRAM' then 'Instagram' when 'WHATSAPP' then 'WhatsApp' when 'GMAIL' then 'Gmail' when 'OUTLOOK' then 'Outlook' else 'the mailbox' end
$$;

-- which ceiling / warm-up table a provider reads: mailboxes keep the LinkedIn rows (their `email` allowance lives there)
create or replace function outreach__ceiling_provider(p outreach_provider_t) returns outreach_provider_t
language sql immutable as $$
  select case when p in ('GMAIL','OUTLOOK','IMAP') then 'LINKEDIN'::outreach_provider_t else p end
$$;

-- outbound = touches the other person; replies, look-ups, checks and polls are not (the quiet period gates outbound only)
create or replace function outreach__is_outbound_type(t outreach_action_type_t) returns boolean
language sql immutable as $$
  select t in ('new_chat','message','follow','unfollow','like','comment','invite','inmail','profile_view','endorse','withdraw','email','story_react')
$$;

-- the sender-local start of a calendar day, as an instant
create or replace function outreach__day_start(p_sender uuid, p_day date) returns timestamptz
language sql stable security definer set search_path = public, extensions as $$
  select (p_day::text || ' 00:00')::timestamp at time zone coalesce((select timezone from outreach_senders where id = p_sender), 'UTC')
$$;

-- an enrollment's graph (pinned version or live) with no membership check: for triggers and workers only
create or replace function outreach__enr_graph(p_enrollment uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select v.graph from outreach_sequence_versions v where v.sequence_id = e.sequence_id and v.version = e.pinned_version), s.graph)
    from outreach_enrollments e join outreach_sequences s on s.id = e.sequence_id where e.id = p_enrollment
$$;

-- -----------------------------------------------------------------------------
-- Identity (PRD §8)
-- -----------------------------------------------------------------------------
-- E.164: '+CC…' or '00CC…' with 8–15 digits → '+digits'. A bare national number is rejected, never guessed.
create or replace function outreach_normalize_phone(p_raw text) returns text
language sql immutable as $$
  select case
    when d ~ '^\+[0-9]{8,15}$' then d
    when d ~ '^00[0-9]{8,15}$' then '+' || substr(d, 3)
    else null end
  from (select regexp_replace(coalesce(p_raw,''), '[[:space:]().-]', '', 'g') as d) x
$$;

-- Instagram handle: lower case, no '@', no instagram.com/ prefix, no trailing slash or query. Null when it is not a handle.
create or replace function outreach_normalize_handle(p_raw text) returns text
language sql immutable as $$
  select h from (
    select regexp_replace(regexp_replace(regexp_replace(lower(trim(coalesce(p_raw,''))), '^(https?://)?(www\.)?instagram\.com/', ''), '[/?#].*$', ''), '^@', '') as h) x
  where h ~ '^[a-z0-9._]{1,30}$'
$$;

create or replace function outreach__identity_normalize(p_provider outreach_provider_t, p_raw text) returns text
language sql immutable as $$
  select case p_provider
    when 'WHATSAPP' then outreach_normalize_phone(p_raw)
    when 'INSTAGRAM' then outreach_normalize_handle(p_raw)
    when 'LINKEDIN' then nullif(regexp_replace(regexp_replace(lower(trim(coalesce(p_raw,''))), '^.*linkedin\.com/in/', ''), '[/?#].*$', ''), '')
    else nullif(lower(trim(coalesce(p_raw,''))), '') end
$$;

-- shared by outreach_identity_add and outreach_upsert_lead: normalise, refuse another lead's identifier, upsert
create or replace function outreach__identity_upsert(p_ws uuid, p_lead uuid, p_provider outreach_provider_t, p_identifier text, p_source text, p_verified boolean, p_provider_id text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare norm text; other uuid; oname text; rid uuid;
begin
  norm := outreach__identity_normalize(p_provider, p_identifier);
  if norm is null then
    if p_provider = 'WHATSAPP' then raise exception 'E_PAYLOAD_INVALID: phone needs a country code, e.g. +91 98765 43210';
    elsif p_provider = 'INSTAGRAM' then raise exception 'E_PAYLOAD_INVALID: not an Instagram handle';
    else raise exception 'E_PAYLOAD_INVALID: identifier is empty'; end if;
  end if;
  select li.lead_id into other from outreach_lead_identities li where li.workspace_id = p_ws and li.provider = p_provider and li.identifier = norm::citext;
  if other is not null and other <> p_lead then
    select coalesce(ld_.full_name, ld_.public_identifier::text, ld_.email_work::text, 'another lead') into oname from outreach_leads ld_ where ld_.id = other;
    raise exception 'E_IDENTITY_CONFLICT: this % already belongs to %', case p_provider when 'WHATSAPP' then 'number' when 'INSTAGRAM' then 'handle' else 'identifier' end, oname;
  end if;
  insert into outreach_lead_identities(workspace_id, lead_id, provider, identifier, provider_id, verified, source)
  values (p_ws, p_lead, p_provider, norm, nullif(p_provider_id,''), coalesce(p_verified, false), coalesce(nullif(p_source,''), 'operator'))
  on conflict (workspace_id, provider, identifier) do update
    set provider_id = coalesce(excluded.provider_id, outreach_lead_identities.provider_id),
        verified = outreach_lead_identities.verified or excluded.verified,
        source = coalesce(outreach_lead_identities.source, excluded.source)
  returning id into rid;
  return rid;
end $$;

create or replace function outreach_identity_add(p_lead uuid, p_provider outreach_provider_t, p_identifier text, p_source text default 'operator', p_verified boolean default true, p_provider_id text default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare ld outreach_leads%rowtype; rid uuid;
begin
  select * into ld from outreach_leads where id = p_lead;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ld.workspace_id, 'member');
  if not outreach_client_visible(ld.workspace_id, ld.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  rid := outreach__identity_upsert(ld.workspace_id, p_lead, p_provider, p_identifier, coalesce(p_source, 'operator'), coalesce(p_verified, true), p_provider_id);
  perform outreach_audit(ld.workspace_id, 'identity.added', 'lead', p_lead::text, jsonb_build_object('identity_id', rid, 'provider', p_provider, 'verified', coalesce(p_verified, true), 'source', coalesce(p_source, 'operator')));
  return rid;
end $$;

-- [{id, provider, identifier, provider_id, verified, source, is_valid, last_checked_at, created_at}]; LinkedIn synthesised from the lead when no row exists
create or replace function outreach_identity_list(p_lead uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare ld outreach_leads%rowtype; res jsonb;
begin
  select * into ld from outreach_leads where id = p_lead;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ld.workspace_id, 'client_viewer');
  if not outreach_client_visible(ld.workspace_id, ld.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', li.id, 'provider', li.provider, 'identifier', li.identifier, 'provider_id', li.provider_id, 'verified', li.verified, 'source', li.source,
           'is_valid', li.is_valid, 'last_checked_at', li.last_checked_at, 'created_at', li.created_at) order by li.provider, li.created_at), '[]'::jsonb)
    into res from outreach_lead_identities li where li.lead_id = p_lead;
  if ld.public_identifier is not null and not exists (select 1 from outreach_lead_identities li where li.lead_id = p_lead and li.provider = 'LINKEDIN') then
    res := jsonb_build_array(jsonb_build_object('id', null, 'provider', 'LINKEDIN', 'identifier', ld.public_identifier, 'provider_id', ld.provider_id, 'verified', true, 'source', 'lead',
             'is_valid', null, 'last_checked_at', null, 'created_at', ld.created_at)) || res;
  end if;
  return res;
end $$;

create or replace function outreach_identity_verify(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare li outreach_lead_identities%rowtype; ld outreach_leads%rowtype;
begin
  select * into li from outreach_lead_identities where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into ld from outreach_leads where id = li.lead_id;
  perform outreach_require(ld.workspace_id, 'member');
  if not outreach_client_visible(ld.workspace_id, ld.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  update outreach_lead_identities set verified = true where id = p_id;
  perform outreach_audit(ld.workspace_id, 'identity.verified', 'lead', ld.id::text, jsonb_build_object('identity_id', p_id, 'provider', li.provider));
end $$;

create or replace function outreach_identity_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare li outreach_lead_identities%rowtype; ld outreach_leads%rowtype;
begin
  select * into li from outreach_lead_identities where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into ld from outreach_leads where id = li.lead_id;
  perform outreach_require(ld.workspace_id, 'member');
  if not outreach_client_visible(ld.workspace_id, ld.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  delete from outreach_lead_identities where id = p_id;
  perform outreach_audit(ld.workspace_id, 'identity.removed', 'lead', ld.id::text, jsonb_build_object('identity_id', p_id, 'provider', li.provider, 'identifier', li.identifier));
end $$;

-- internal: the usable identity for a channel ({id, identifier, provider_id, verified, is_valid}) or null. Verified rows only;
-- LinkedIn falls back to the lead's own slug / provider id.
create or replace function outreach_lead_identity(p_lead uuid, p_provider outreach_provider_t) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare li outreach_lead_identities%rowtype; ld outreach_leads%rowtype;
begin
  select * into li from outreach_lead_identities x where x.lead_id = p_lead and x.provider = p_provider and x.verified
   order by (x.provider_id is not null) desc, x.created_at desc limit 1;
  if found then
    return jsonb_build_object('id', li.id, 'identifier', li.identifier, 'provider_id', li.provider_id, 'verified', li.verified, 'is_valid', li.is_valid);
  end if;
  if p_provider = 'LINKEDIN' then
    select * into ld from outreach_leads where id = p_lead;
    if found and (ld.public_identifier is not null or ld.provider_id is not null) then
      return jsonb_build_object('id', null, 'identifier', ld.public_identifier, 'provider_id', ld.provider_id, 'verified', true, 'is_valid', null);
    end if;
  end if;
  return null;
end $$;

create or replace function outreach_identity_set_check(p_id uuid, p_valid boolean, p_provider_id text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_lead_identities set is_valid = p_valid, last_checked_at = now(), provider_id = coalesce(nullif(p_provider_id,''), provider_id) where id = p_id;
end $$;

-- -----------------------------------------------------------------------------
-- Consent (PRD §6)
-- -----------------------------------------------------------------------------
create or replace function outreach__consent_active(p_lead uuid, p_channel outreach_provider_t) returns outreach_lead_consent
language sql stable security definer set search_path = public, extensions as $$
  select c.* from outreach_lead_consent c
   where c.lead_id = p_lead and c.channel = p_channel and c.revoked_at is null and (c.expires_at is null or c.expires_at > now())
   order by c.obtained_at desc limit 1
$$;

create or replace function outreach_lead_has_consent(p_lead uuid, p_channel outreach_provider_t) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from outreach_lead_consent c
                  where c.lead_id = p_lead and c.channel = p_channel and c.revoked_at is null and (c.expires_at is null or c.expires_at > now()))
$$;

create or replace function outreach__consent_insert(p_ws uuid, p_lead uuid, p_channel outreach_provider_t, p_basis outreach_consent_basis_t, p_evidence jsonb, p_obtained_at timestamptz, p_expires_at timestamptz, p_attested_by uuid)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare cid uuid;
begin
  update outreach_lead_consent set revoked_at = now(), revoked_reason = 'replaced' where lead_id = p_lead and channel = p_channel and revoked_at is null;
  insert into outreach_lead_consent(workspace_id, lead_id, channel, basis, evidence, attested_by, obtained_at, expires_at)
  values (p_ws, p_lead, p_channel, p_basis, coalesce(p_evidence, '{}'::jsonb), p_attested_by, coalesce(p_obtained_at, now()), p_expires_at)
  returning id into cid;
  return cid;
end $$;

create or replace function outreach_consent_grant(p_lead uuid, p_channel outreach_provider_t, p_basis outreach_consent_basis_t, p_evidence jsonb default '{}', p_obtained_at timestamptz default now(), p_expires_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare ld outreach_leads%rowtype; cid uuid;
begin
  select * into ld from outreach_leads where id = p_lead;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ld.workspace_id, 'member');
  if not outreach_client_visible(ld.workspace_id, ld.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if p_basis in ('form_optin','existing_customer') and coalesce(nullif(p_evidence->>'url',''), nullif(p_evidence->>'note','')) is null then
    raise exception 'E_PAYLOAD_INVALID: evidence required for this basis';
  end if;
  if p_expires_at is not null and p_expires_at <= coalesce(p_obtained_at, now()) then raise exception 'E_PAYLOAD_INVALID: expiry must be after the date consent was obtained'; end if;
  cid := outreach__consent_insert(ld.workspace_id, p_lead, p_channel, p_basis, p_evidence, p_obtained_at, p_expires_at, auth.uid());
  perform outreach_audit(ld.workspace_id, 'consent.granted', 'lead', p_lead::text, jsonb_build_object('consent_id', cid, 'channel', p_channel, 'basis', p_basis, 'evidence', coalesce(p_evidence,'{}'::jsonb), 'expires_at', p_expires_at));
  return cid;
end $$;

-- service (inbound): records the basis when no active consent exists; otherwise returns the active row untouched
create or replace function outreach_consent_grant_system(p_lead uuid, p_channel outreach_provider_t, p_basis outreach_consent_basis_t, p_evidence jsonb)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare ld outreach_leads%rowtype; cur outreach_lead_consent%rowtype; cid uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into ld from outreach_leads where id = p_lead;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  cur := outreach__consent_active(p_lead, p_channel);
  if cur.id is not null then return cur.id; end if;
  cid := outreach__consent_insert(ld.workspace_id, p_lead, p_channel, p_basis, p_evidence, now(), null, null);
  perform outreach_audit(ld.workspace_id, 'consent.granted', 'lead', p_lead::text, jsonb_build_object('consent_id', cid, 'channel', p_channel, 'basis', p_basis, 'evidence', coalesce(p_evidence,'{}'::jsonb)), 'system');
  return cid;
end $$;

-- exits the lead's live enrollments on that channel and cancels its queued actions on senders of that provider
create or replace function outreach__consent_exit(p_lead uuid, p_channel outreach_provider_t, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare r record;
begin
  for r in select en_.id from outreach_enrollments en_ join outreach_senders sn_ on sn_.id = en_.sender_id
            where en_.lead_id = p_lead and en_.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')
              and coalesce(en_.current_channel, sn_.provider) = p_channel loop
    perform outreach_complete_enrollment(r.id, 'exited_suppressed', p_reason);
  end loop;
  update outreach_actions a set status = 'cancelled', decision = p_reason
   where a.lead_id = p_lead and a.status in ('queued','reserved') and a.action_type <> 'reply'
     and exists (select 1 from outreach_senders sn_ where sn_.id = a.sender_id and sn_.provider = p_channel);
end $$;

create or replace function outreach_consent_revoke(p_id uuid, p_reason text default 'manual') returns void
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_lead_consent%rowtype; ld outreach_leads%rowtype;
begin
  select * into c from outreach_lead_consent where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into ld from outreach_leads where id = c.lead_id;
  perform outreach_require(ld.workspace_id, 'member');
  if not outreach_client_visible(ld.workspace_id, ld.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if c.revoked_at is not null then return; end if;
  update outreach_lead_consent set revoked_at = now(), revoked_reason = coalesce(nullif(p_reason,''), 'manual') where id = p_id;
  perform outreach__consent_exit(c.lead_id, c.channel, 'consent_revoked');
  perform outreach_audit(ld.workspace_id, 'consent.revoked', 'lead', c.lead_id::text, jsonb_build_object('consent_id', p_id, 'channel', c.channel, 'basis', c.basis, 'reason', p_reason));
end $$;

-- service (inbound stop request): revoke + suppress the number / handle + exit, all in one place
create or replace function outreach_consent_revoke_stop(p_lead uuid, p_channel outreach_provider_t, p_message_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ld outreach_leads%rowtype; ident text; k text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into ld from outreach_leads where id = p_lead;
  if not found then return; end if;
  update outreach_lead_consent set revoked_at = now(), revoked_reason = 'stop_request',
         evidence = evidence || jsonb_build_object('stop_message_id', p_message_id)
   where lead_id = p_lead and channel = p_channel and revoked_at is null;
  select li.identifier::text into ident from outreach_lead_identities li where li.lead_id = p_lead and li.provider = p_channel order by li.verified desc, li.created_at desc limit 1;
  k := case p_channel when 'WHATSAPP' then 'phone' when 'INSTAGRAM' then 'handle' when 'LINKEDIN' then 'public_identifier' else null end;
  if p_channel = 'LINKEDIN' then ident := coalesce(ident, ld.public_identifier::text); end if;
  if k is not null and ident is not null then
    insert into outreach_suppressions(workspace_id, kind, value, reason, source) values (ld.workspace_id, k, ident, 'stop request', 'stop') on conflict do nothing;
  end if;
  perform outreach__consent_exit(p_lead, p_channel, 'stop_request');
  perform outreach_audit(ld.workspace_id, 'consent.stop_request', 'lead', p_lead::text, jsonb_build_object('channel', p_channel, 'message_id', p_message_id, 'suppressed', k is not null and ident is not null), 'system');
end $$;

create or replace function outreach_consent_list(p_ws uuid, p_lead uuid default null, p_channel outreach_provider_t default null, p_basis outreach_consent_basis_t default null, p_include_revoked boolean default false, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'lead_id', c.lead_id, 'lead_name', ld_.full_name, 'channel', c.channel, 'basis', c.basis, 'evidence', c.evidence,
            'attested_by', c.attested_by, 'attested_by_email', (select coalesce(mb.email::text, au.email::text) from auth.users au left join outreach_members mb on mb.user_id = au.id and mb.workspace_id = p_ws where au.id = c.attested_by),
            'obtained_at', c.obtained_at, 'expires_at', c.expires_at, 'revoked_at', c.revoked_at, 'revoked_reason', c.revoked_reason, 'created_at', c.created_at) order by c.obtained_at desc), '[]'::jsonb)
          from (select c0.* from outreach_lead_consent c0 join outreach_leads l0_ on l0_.id = c0.lead_id
                 where c0.workspace_id = p_ws and outreach_client_visible(p_ws, l0_.client_id)
                   and (p_lead is null or c0.lead_id = p_lead) and (p_channel is null or c0.channel = p_channel) and (p_basis is null or c0.basis = p_basis)
                   and (p_include_revoked or c0.revoked_at is null)
                 order by c0.obtained_at desc
                 limit least(greatest(coalesce(p_limit, 200), 1), 2000)) c
          join outreach_leads ld_ on ld_.id = c.lead_id);
end $$;

-- The artefact produced when a client's number is challenged: who was contacted on WhatsApp, on what basis, with what evidence.
create or replace function outreach_consent_report(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); f date; t date; f_ts timestamptz; t_ts timestamptz; rows_ jsonb; contacted int; by_basis jsonb; ia_share numeric;
begin
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29);
  perform outreach__check_range(p_ws, p_client, f, t);
  f_ts := f::timestamp at time zone z; t_ts := (t + 1)::timestamp at time zone z;
  with contacted as (
    select a.lead_id, min(a.executed_at) as first_at
      from outreach_actions a join outreach_senders sn_ on sn_.id = a.sender_id join outreach_leads ld_ on ld_.id = a.lead_id
     where a.workspace_id = p_ws and sn_.provider = 'WHATSAPP' and a.action_type = 'new_chat' and a.status = 'sent'
       and a.executed_at >= f_ts and a.executed_at < t_ts
       and (p_client is null or coalesce(ld_.client_id, sn_.client_id) = p_client) and outreach_client_visible(p_ws, ld_.client_id)
     group by a.lead_id),
  det as (
    select c.lead_id, c.first_at, ld_.full_name, cs.basis, cs.obtained_at, cs.evidence, cs.attested_by,
           (select sn2.display_name from outreach_actions a2 join outreach_senders sn2 on sn2.id = a2.sender_id
             where a2.lead_id = c.lead_id and a2.action_type = 'new_chat' and a2.status = 'sent' and a2.executed_at = c.first_at limit 1) as sender_name
      from contacted c join outreach_leads ld_ on ld_.id = c.lead_id
      left join lateral (select x.* from outreach_lead_consent x where x.lead_id = c.lead_id and x.channel = 'WHATSAPP' order by (x.revoked_at is null) desc, x.obtained_at desc limit 1) cs on true)
  select count(*), coalesce(jsonb_agg(jsonb_build_object('lead_id', d.lead_id, 'lead_name', d.full_name, 'basis', coalesce(d.basis::text, 'none'), 'obtained_at', d.obtained_at, 'evidence', d.evidence,
           'attested_by_email', (select coalesce(mb.email::text, au.email::text) from auth.users au left join outreach_members mb on mb.user_id = au.id and mb.workspace_id = p_ws where au.id = d.attested_by),
           'first_new_chat_at', d.first_at, 'sender_name', d.sender_name) order by d.first_at desc), '[]'::jsonb)
    into contacted, rows_ from det d;
  select coalesce(jsonb_object_agg(b.basis, jsonb_build_object('leads', b.n, 'share_pct', outreach__rate(b.n, contacted))), '{}'::jsonb) into by_basis
    from (select x->>'basis' as basis, count(*) as n from jsonb_array_elements(rows_) x group by 1) b;
  ia_share := coalesce((by_basis->'imported_attested'->>'share_pct')::numeric, 0);
  return jsonb_build_object('period', jsonb_build_object('from', f, 'to', t, 'timezone', z), 'contacted', contacted, 'by_basis', by_basis,
    'imported_attested_share_pct', ia_share, 'alert', ia_share > 30, 'rows', rows_);
end $$;

-- -----------------------------------------------------------------------------
-- Ledger (PRD §7.1): per-provider ceilings, hourly + daily "all actions" scopes
-- -----------------------------------------------------------------------------
create or replace function outreach_channel_caps(p_provider outreach_provider_t) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select to_jsonb(c) from outreach_channel_capabilities c where c.provider = p_provider
$$;

-- every action type that belongs to a scoped (hour or day) ledger of the provider
create or replace function outreach_scoped_types(p_provider outreach_provider_t) returns text[]
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(array_agg(distinct x), '{}')
    from outreach_channel_capabilities c,
         jsonb_array_elements_text(case when jsonb_typeof(c.ledger->'hourly') = 'object' then coalesce(c.ledger->'hourly'->'types', '[]'::jsonb) else '[]'::jsonb end
                                   || case when jsonb_typeof(c.ledger->'daily_scope') = 'object' then coalesce(c.ledger->'daily_scope'->'types', '[]'::jsonb) else '[]'::jsonb end) x
   where c.provider = p_provider
$$;

-- min(ceiling, warm-up cap, manual cap) × health multiplier, read for the SENDER'S provider (mailboxes read the LinkedIn rows)
create or replace function outreach_effective_cap(p_sender uuid, p_type outreach_action_type_t) returns int
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; ceil_v int; warm_v int; man_v int; base int; mult numeric := 1; cp outreach_provider_t;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then return 0; end if;
  cp := outreach__ceiling_provider(s.provider);
  select per_day into ceil_v from outreach_platform_ceilings where provider = cp and action_type = p_type;
  if ceil_v is null then return 0; end if;
  if p_type in ('reply','call_api','relations_poll','find_email') then return ceil_v; end if;
  select per_day into warm_v from outreach_warmup_caps where provider = cp and level = s.warmup_level and action_type = p_type;
  base := least(ceil_v, coalesce(warm_v, ceil_v));
  if s.manual_caps ? p_type::text then
    man_v := (s.manual_caps->>p_type::text)::int;
    base := least(base, greatest(man_v, 0));
  end if;
  if s.health_score < 50 then mult := 0;
  elsif s.health_score < 70 then mult := 0.6; end if;
  return floor(base * mult)::int;
end $$;

-- Instagram's daily "all metered actions" cap at the sender's level × health multiplier; null when the provider has no daily scope
create or replace function outreach_effective_total_cap(p_sender uuid) returns int
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; caps outreach_channel_capabilities%rowtype; tot int; mult numeric := 1; man_v int; sc text;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then return null; end if;
  select * into caps from outreach_channel_capabilities where provider = s.provider;
  if caps.provider is null or coalesce(jsonb_typeof(caps.ledger->'daily_scope'), 'null') <> 'object' then return null; end if;
  select per_day into tot from outreach_channel_totals where provider = s.provider and level = s.warmup_level;
  if tot is null then return null; end if;
  sc := caps.ledger->'daily_scope'->>'scope';
  if s.manual_caps ? sc then man_v := (s.manual_caps->>sc)::int; tot := least(tot, greatest(man_v, 0)); end if;
  if s.health_score < 50 then mult := 0;
  elsif s.health_score < 70 then mult := 0.6; end if;
  return floor(tot * mult)::int;
end $$;

-- Daily budget rows for the provider's ceilings (unchanged arithmetic) + the ('day', day_start, scope) row when the descriptor has a daily scope
create or replace function outreach_plan_budgets(p_sender uuid, p_day date)
returns setof outreach_sender_budgets
language plpgsql security definer set search_path = public, extensions as $$
declare t outreach_action_type_t; base int; capv int; has_window boolean; jitter numeric; wk int; wk_ceiling int;
        sn outreach_senders%rowtype; cp outreach_provider_t; caps outreach_channel_capabilities%rowtype; totv int;
begin
  select * into sn from outreach_senders where id = p_sender;
  if not found then return; end if;
  cp := outreach__ceiling_provider(sn.provider);
  select exists(select 1 from outreach_schedule_windows(p_sender, p_day)) into has_window;
  for t in select action_type from outreach_platform_ceilings where provider = cp loop
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
        select per_week into wk_ceiling from outreach_platform_ceilings where provider = cp and action_type = 'invite';
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
  select * into caps from outreach_channel_capabilities where provider = sn.provider;
  if coalesce(jsonb_typeof(caps.ledger->'daily_scope'), 'null') = 'object' then
    totv := case when has_window then coalesce(outreach_effective_total_cap(p_sender), 0) else 0 end;
    insert into outreach_sender_budgets_scoped(sender_id, "window", window_start, scope, cap)
    values (p_sender, 'day', outreach__day_start(p_sender, p_day), caps.ledger->'daily_scope'->>'scope', totv)
    on conflict (sender_id, "window", window_start, scope) do update
      set cap = greatest(excluded.cap, outreach_sender_budgets_scoped.used + outreach_sender_budgets_scoped.reserved);
  end if;
  return query select * from outreach_sender_budgets where sender_id = p_sender and day = p_day;
end $$;

-- ('hour', date_trunc('hour', p_at), scope, cap): the descriptor's hourly cap, 0 when health < 50
create or replace function outreach_ensure_hour_budget(p_sender uuid, p_at timestamptz) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare sn outreach_senders%rowtype; caps outreach_channel_capabilities%rowtype; capv int;
begin
  select * into sn from outreach_senders where id = p_sender;
  if not found then return; end if;
  select * into caps from outreach_channel_capabilities where provider = sn.provider;
  if coalesce(jsonb_typeof(caps.ledger->'hourly'), 'null') <> 'object' then return; end if;
  capv := case when sn.health_score < 50 then 0 else coalesce((caps.ledger->'hourly'->>'cap')::int, 0) end;
  insert into outreach_sender_budgets_scoped(sender_id, "window", window_start, scope, cap)
  values (p_sender, 'hour', date_trunc('hour', p_at), caps.ledger->'hourly'->>'scope', capv)
  on conflict (sender_id, "window", window_start, scope) do update
    set cap = greatest(excluded.cap, outreach_sender_budgets_scoped.used + outreach_sender_budgets_scoped.reserved);
end $$;

-- Seconds the sender must wait between two provider actions at EXECUTION time (descriptor min_gap_seconds[0]).
-- Only Instagram and WhatsApp carry an execution-time floor (PRD §7.2: WhatsApp's documented 10–20 s). LinkedIn and
-- mailboxes keep their planner-time spacing only, so their throughput is unchanged (PRD §2.1 goal 6): 0 for them.
create or replace function outreach_sender_min_gap(p_sender uuid) returns int
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select case when s.provider in ('INSTAGRAM','WHATSAPP') then coalesce((c.ledger->'min_gap_seconds'->>0)::int, 0) else 0 end
                     from outreach_senders s join outreach_channel_capabilities c on c.provider = s.provider where s.id = p_sender), 0)
$$;

-- The reservation, with the reason it failed: 'ok' | 'day' (per-type daily row) | 'day_scope' (daily all-actions) | 'hour'.
-- Order: daily row, then the day scope, then the hour scope; anything taken before a failure is given back.
create or replace function outreach__reserve_why(p_sender uuid, p_day date, p_type outreach_action_type_t, p_at timestamptz) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare ok boolean; prov outreach_provider_t; caps outreach_channel_capabilities%rowtype; ds timestamptz; d_scope text; h_scope text; taken_day boolean := false;
begin
  update outreach_sender_budgets set reserved = reserved + 1
   where sender_id = p_sender and day = p_day and action_type = p_type and used + reserved < cap
   returning true into ok;
  if ok is null then
    if not exists (select 1 from outreach_sender_budgets where sender_id = p_sender and day = p_day and action_type = p_type) then
      perform outreach_plan_budgets(p_sender, p_day);
      update outreach_sender_budgets set reserved = reserved + 1
       where sender_id = p_sender and day = p_day and action_type = p_type and used + reserved < cap
       returning true into ok;
    end if;
  end if;
  if not coalesce(ok, false) then return 'day'; end if;

  select provider into prov from outreach_senders where id = p_sender;
  select * into caps from outreach_channel_capabilities where provider = prov;
  if caps.provider is null then return 'ok'; end if;

  if coalesce(jsonb_typeof(caps.ledger->'daily_scope'), 'null') = 'object' and (caps.ledger->'daily_scope'->'types') ? p_type::text then
    d_scope := caps.ledger->'daily_scope'->>'scope'; ds := outreach__day_start(p_sender, p_day); ok := null;
    update outreach_sender_budgets_scoped set reserved = reserved + 1
     where sender_id = p_sender and "window" = 'day' and window_start = ds and scope = d_scope and used + reserved < cap
     returning true into ok;
    if ok is null and not exists (select 1 from outreach_sender_budgets_scoped where sender_id = p_sender and "window" = 'day' and window_start = ds and scope = d_scope) then
      perform outreach_plan_budgets(p_sender, p_day);
      update outreach_sender_budgets_scoped set reserved = reserved + 1
       where sender_id = p_sender and "window" = 'day' and window_start = ds and scope = d_scope and used + reserved < cap
       returning true into ok;
    end if;
    if not coalesce(ok, false) then
      update outreach_sender_budgets set reserved = greatest(reserved - 1, 0) where sender_id = p_sender and day = p_day and action_type = p_type;
      return 'day_scope';
    end if;
    taken_day := true;
  end if;

  if coalesce(jsonb_typeof(caps.ledger->'hourly'), 'null') = 'object' and (caps.ledger->'hourly'->'types') ? p_type::text then
    h_scope := caps.ledger->'hourly'->>'scope'; ok := null;
    perform outreach_ensure_hour_budget(p_sender, p_at);
    update outreach_sender_budgets_scoped set reserved = reserved + 1
     where sender_id = p_sender and "window" = 'hour' and window_start = date_trunc('hour', p_at) and scope = h_scope and used + reserved < cap
     returning true into ok;
    if not coalesce(ok, false) then
      update outreach_sender_budgets set reserved = greatest(reserved - 1, 0) where sender_id = p_sender and day = p_day and action_type = p_type;
      if taken_day then
        update outreach_sender_budgets_scoped set reserved = greatest(reserved - 1, 0) where sender_id = p_sender and "window" = 'day' and window_start = ds and scope = d_scope;
      end if;
      return 'hour';
    end if;
  end if;
  return 'ok';
end $$;

-- 4-argument forms (no default on p_at: a default would make the 3-argument calls ambiguous)
create or replace function outreach_reserve_budget(p_sender uuid, p_day date, p_type outreach_action_type_t, p_at timestamptz) returns boolean
language sql security definer set search_path = public, extensions as $$
  select outreach__reserve_why(p_sender, p_day, p_type, p_at) = 'ok'
$$;

create or replace function outreach_consume_budget(p_sender uuid, p_day date, p_type outreach_action_type_t, p_at timestamptz) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare prov outreach_provider_t; caps outreach_channel_capabilities%rowtype;
begin
  update outreach_sender_budgets set used = used + 1, reserved = greatest(reserved - 1, 0)
   where sender_id = p_sender and day = p_day and action_type = p_type;
  select provider into prov from outreach_senders where id = p_sender;
  select * into caps from outreach_channel_capabilities where provider = prov;
  if caps.provider is null then return; end if;
  if coalesce(jsonb_typeof(caps.ledger->'daily_scope'), 'null') = 'object' and (caps.ledger->'daily_scope'->'types') ? p_type::text then
    update outreach_sender_budgets_scoped set used = used + 1, reserved = greatest(reserved - 1, 0)
     where sender_id = p_sender and "window" = 'day' and window_start = outreach__day_start(p_sender, p_day) and scope = caps.ledger->'daily_scope'->>'scope';
  end if;
  if coalesce(jsonb_typeof(caps.ledger->'hourly'), 'null') = 'object' and (caps.ledger->'hourly'->'types') ? p_type::text then
    update outreach_sender_budgets_scoped set used = used + 1, reserved = greatest(reserved - 1, 0)
     where sender_id = p_sender and "window" = 'hour' and window_start = date_trunc('hour', p_at) and scope = caps.ledger->'hourly'->>'scope';
  end if;
end $$;

create or replace function outreach_release_budget(p_sender uuid, p_day date, p_type outreach_action_type_t, p_at timestamptz) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare prov outreach_provider_t; caps outreach_channel_capabilities%rowtype;
begin
  update outreach_sender_budgets set reserved = greatest(reserved - 1, 0)
   where sender_id = p_sender and day = p_day and action_type = p_type;
  select provider into prov from outreach_senders where id = p_sender;
  select * into caps from outreach_channel_capabilities where provider = prov;
  if caps.provider is null then return; end if;
  if coalesce(jsonb_typeof(caps.ledger->'daily_scope'), 'null') = 'object' and (caps.ledger->'daily_scope'->'types') ? p_type::text then
    update outreach_sender_budgets_scoped set reserved = greatest(reserved - 1, 0)
     where sender_id = p_sender and "window" = 'day' and window_start = outreach__day_start(p_sender, p_day) and scope = caps.ledger->'daily_scope'->>'scope';
  end if;
  if coalesce(jsonb_typeof(caps.ledger->'hourly'), 'null') = 'object' and (caps.ledger->'hourly'->'types') ? p_type::text then
    update outreach_sender_budgets_scoped set reserved = greatest(reserved - 1, 0)
     where sender_id = p_sender and "window" = 'hour' and window_start = date_trunc('hour', p_at) and scope = caps.ledger->'hourly'->>'scope';
  end if;
end $$;

-- 3-argument forms stay for the TypeScript callers (reserve → call → consume | release): they delegate with now()
create or replace function outreach_reserve_budget(p_sender uuid, p_day date, p_type outreach_action_type_t) returns boolean
language sql security definer set search_path = public, extensions as $$
  select outreach_reserve_budget(p_sender, p_day, p_type, now())
$$;
create or replace function outreach_consume_budget(p_sender uuid, p_day date, p_type outreach_action_type_t) returns void
language sql security definer set search_path = public, extensions as $$
  select outreach_consume_budget(p_sender, p_day, p_type, now())
$$;
create or replace function outreach_release_budget(p_sender uuid, p_day date, p_type outreach_action_type_t) returns void
language sql security definer set search_path = public, extensions as $$
  select outreach_release_budget(p_sender, p_day, p_type, now())
$$;

-- {scope, hour_start, cap, used, reserved, remaining} for the current hour, or {} when the provider has no hourly cap
create or replace function outreach_sender_hour(p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare sn outreach_senders%rowtype; caps outreach_channel_capabilities%rowtype; hs timestamptz; b outreach_sender_budgets_scoped%rowtype; capv int;
begin
  select * into sn from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(sn.workspace_id, 'client_viewer');
  if not outreach_client_visible(sn.workspace_id, sn.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  select * into caps from outreach_channel_capabilities where provider = sn.provider;
  if coalesce(jsonb_typeof(caps.ledger->'hourly'), 'null') <> 'object' then return '{}'::jsonb; end if;
  hs := date_trunc('hour', now());
  select * into b from outreach_sender_budgets_scoped where sender_id = p_sender and "window" = 'hour' and window_start = hs and scope = caps.ledger->'hourly'->>'scope';
  if not found then
    capv := case when sn.health_score < 50 then 0 else coalesce((caps.ledger->'hourly'->>'cap')::int, 0) end;
    return jsonb_build_object('scope', caps.ledger->'hourly'->>'scope', 'hour_start', hs, 'cap', capv, 'used', 0, 'reserved', 0, 'remaining', capv);
  end if;
  return jsonb_build_object('scope', b.scope, 'hour_start', b.window_start, 'cap', b.cap, 'used', b.used, 'reserved', b.reserved, 'remaining', greatest(b.cap - b.used - b.reserved, 0));
end $$;

-- {day: {...}|null, hour: {...}|null} — the two scoped rows that matter right now
create or replace function outreach_sender_scopes_today(p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare sn outreach_senders%rowtype; caps outreach_channel_capabilities%rowtype; b outreach_sender_budgets_scoped%rowtype; dayj jsonb; hourj jsonb; ds timestamptz;
begin
  select * into sn from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(sn.workspace_id, 'client_viewer');
  if not outreach_client_visible(sn.workspace_id, sn.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  select * into caps from outreach_channel_capabilities where provider = sn.provider;
  if coalesce(jsonb_typeof(caps.ledger->'daily_scope'), 'null') = 'object' then
    ds := outreach__day_start(p_sender, outreach_sender_local_date(p_sender, now()));
    select * into b from outreach_sender_budgets_scoped where sender_id = p_sender and "window" = 'day' and window_start = ds and scope = caps.ledger->'daily_scope'->>'scope';
    if found then dayj := jsonb_build_object('scope', b.scope, 'day_start', b.window_start, 'cap', b.cap, 'used', b.used, 'reserved', b.reserved, 'remaining', greatest(b.cap - b.used - b.reserved, 0));
    else dayj := jsonb_build_object('scope', caps.ledger->'daily_scope'->>'scope', 'day_start', ds, 'cap', coalesce(outreach_effective_total_cap(p_sender), 0), 'used', 0, 'reserved', 0, 'remaining', coalesce(outreach_effective_total_cap(p_sender), 0)); end if;
  end if;
  hourj := outreach_sender_hour(p_sender);
  return jsonb_build_object('day', dayj, 'hour', case when hourj = '{}'::jsonb then null else hourj end);
end $$;

-- [{sender_id, name, provider, status, level, quiet_until, today: {type: remaining}, hour: {cap, remaining} | null}]
create or replace function outreach_channel_capacity(p_ws uuid, p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare vis uuid[] := outreach_visible_clients(p_ws);
begin
  perform outreach_require(p_ws, 'client_viewer');
  if p_client is not null and not outreach_client_visible(p_ws, p_client) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('sender_id', s.id, 'name', s.display_name, 'provider', s.provider, 'status', s.status, 'level', s.warmup_level,
             'quiet_until', case when s.outreach_allowed_from > now() then s.outreach_allowed_from end,
             'today', (select coalesce(jsonb_object_agg(b.action_type, greatest(b.cap - b.used - b.reserved, 0)), '{}'::jsonb)
                         from outreach_sender_budgets b where b.sender_id = s.id and b.day = outreach_sender_local_date(s.id, now())),
             'hour', (select case when coalesce(jsonb_typeof(c.ledger->'hourly'), 'null') = 'object' then
                        jsonb_build_object('cap', coalesce(h.cap, case when s.health_score < 50 then 0 else (c.ledger->'hourly'->>'cap')::int end),
                                           'remaining', coalesce(greatest(h.cap - h.used - h.reserved, 0), case when s.health_score < 50 then 0 else (c.ledger->'hourly'->>'cap')::int end)) end
                        from outreach_channel_capabilities c
                        left join outreach_sender_budgets_scoped h on h.sender_id = s.id and h."window" = 'hour' and h.window_start = date_trunc('hour', now()) and h.scope = c.ledger->'hourly'->>'scope'
                       where c.provider = s.provider)) order by s.provider, s.display_name), '[]'::jsonb)
            from outreach_senders s
           where s.workspace_id = p_ws and s.deleted_at is null and s.provider in ('LINKEDIN','INSTAGRAM','WHATSAPP')
             and (p_client is null or s.client_id = p_client) and (vis is null or s.client_id is null or s.client_id = any(vis)));
end $$;

-- -----------------------------------------------------------------------------
-- Claim / complete / fail / sweep (service): min gap, quiet period, hourly deferral, reserved_at-based settlement
-- -----------------------------------------------------------------------------
create or replace function outreach_claim_due_actions(p_limit int default 200)
returns setof outreach_actions
language plpgsql security definer set search_path = public, extensions as $$
declare r record; d date; why text;
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
          -- post-connect quiet period (PRD §7.3): outbound waits; replies, checks and polls do not
          and not (outreach__is_outbound_type(a2.action_type) and s.outreach_allowed_from is not null and s.outreach_allowed_from > now())
          -- minimum gap between provider actions on one sender (PRD §7.2)
          and (a2.action_type in ('reply','call_api','find_email')
               or not exists (select 1 from outreach_actions la
                               where la.sender_id = a2.sender_id and la.status in ('sent','failed') and la.action_type <> 'reply'
                                 and la.executed_at > now() - make_interval(secs => outreach_sender_min_gap(s.id))))
          and not exists (select 1 from outreach_actions r2 where r2.sender_id = a2.sender_id and r2.status = 'reserved')
      ) x where x.rn = 1 limit p_limit
    )
    for update skip locked
  loop
    if r.status <> 'queued' then continue; end if;
    d := outreach_sender_local_date(r.sender_id, now());
    why := outreach__reserve_why(r.sender_id, d, r.action_type, now());
    if why = 'ok' then
      update outreach_actions set status = 'reserved', reserved_at = now() where id = r.id;
      return query select * from outreach_actions where id = r.id;
    elsif why = 'hour' then
      update outreach_actions set scheduled_for = date_trunc('hour', now()) + interval '1 hour' + make_interval(mins => floor(random() * 20)::int, secs => floor(random() * 59)::int),
             decision = 'hourly_deferred' where id = r.id;
    else
      update outreach_actions set scheduled_for = now() + interval '1 day', decision = 'budget_deferred' where id = r.id;
    end if;
  end loop;
end $$;

create or replace function outreach_complete_action(p_id uuid, p_response jsonb default null, p_branch text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare a outreach_actions%rowtype; d date;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into a from outreach_actions where id = p_id for update;
  if not found or a.status <> 'reserved' then return; end if;
  update outreach_actions set status = 'sent', executed_at = now(), response = p_response where id = p_id;
  d := outreach_sender_local_date(a.sender_id, coalesce(a.reserved_at, now()));
  perform outreach_consume_budget(a.sender_id, d, a.action_type, coalesce(a.reserved_at, now()));
  if a.enrollment_id is not null
     and not coalesce((a.payload->>'prefetch')::boolean, false)
     and not coalesce((a.payload->>'subtask')::boolean, false) then
    perform outreach_advance_enrollment(a.enrollment_id, a.node_id, p_branch);
  end if;
end $$;

create or replace function outreach_fail_action(p_id uuid, p_code text, p_decision text, p_retry_at timestamptz default null, p_branch text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare a outreach_actions%rowtype; d date; is_main boolean;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into a from outreach_actions where id = p_id for update;
  if not found or a.status <> 'reserved' then return; end if;
  d := outreach_sender_local_date(a.sender_id, coalesce(a.reserved_at, now()));
  perform outreach_release_budget(a.sender_id, d, a.action_type, coalesce(a.reserved_at, now()));
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

create or replace function outreach_sweep_stale_reservations() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare r record; cnt int := 0;
begin
  for r in select id, sender_id, action_type, reserved_at from outreach_actions where status = 'reserved' and reserved_at < now() - interval '10 minutes' loop
    perform outreach_release_budget(r.sender_id, outreach_sender_local_date(r.sender_id, r.reserved_at), r.action_type, r.reserved_at);
    update outreach_actions set status = 'queued', reserved_at = null, decision = 'stale_reservation' where id = r.id;
    cnt := cnt + 1;
  end loop;
  return cnt;
end $$;

-- -----------------------------------------------------------------------------
-- Node catalogue: the nine channel steps
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
    when 'follow' then 'follow'
    when 'unfollow' then 'unfollow'
    when 'like_recent_posts' then 'like'
    when 'comment_post' then 'comment'
    when 'check_identifier' then 'identifier_check'
    when 'send_invite' then 'invite'
    when 'withdraw_invite' then 'withdraw'
    when 'send_message' then 'message'
    when 'send_voice_note' then 'message'      -- a voice note is a message: the planner decides message vs new_chat
    when 'send_inmail' then 'inmail'
    when 'send_email' then 'email'
    when 'call_api' then 'call_api'
    when 'find_email' then 'find_email'
    else null end
$$;

create or replace function outreach_is_executable_node(p_type text) returns boolean
language sql immutable as $$
  select p_type in ('visit_profile','refresh_profile','like_latest_post','comment_latest_post','endorse_skills','follow_profile','send_invite',
                    'withdraw_invite','send_message','send_voice_note','send_inmail','send_email','call_api','find_email',
                    'follow','unfollow','like_recent_posts','comment_post','check_identifier')
$$;

create or replace function outreach_node_types() returns text[]
language sql immutable as $$
  select array['start','end','visit_profile','refresh_profile','like_latest_post','comment_latest_post','endorse_skills','follow_profile','send_invite',
    'wait_connection','withdraw_invite','send_message','send_voice_note','send_inmail','send_email','delay','condition','rotate_sender',
    'change_sender','add_tag','remove_tag','change_list','change_stage','call_webhook','call_api','find_email','send_to_sequence',
    'manual_task','call_task','ai_draft_approval','ab_split','ai_route',
    'follow','unfollow','like_recent_posts','comment_post','wait_follow_back','check_identifier','require_consent','wait_for_reply','channel_switch']
$$;

-- -----------------------------------------------------------------------------
-- Engine: enter a node and chain through passive nodes (011 + require_consent, wait_follow_back, wait_for_reply, channel_switch)
-- -----------------------------------------------------------------------------
create or replace function outreach_enter_node(p_enrollment uuid, p_node_id text, p_not_before timestamptz default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  e outreach_enrollments%rowtype; seq outreach_sequences%rowtype; g jsonb; n jsonb; t text; nid text; guard int := 0;
  amount numeric; unit text; jit numeric; iv interval; rel outreach_relation_t; branch text; pool uuid[]; pos int; nxt_sender uuid;
  new_id uuid; target uuid; dec outreach_ai_route_decisions%rowtype;
  ch outreach_provider_t; cons outreach_lead_consent%rowtype; ident jsonb; caps outreach_channel_capabilities%rowtype; cur_prov outreach_provider_t;
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
      insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, pinned_version, lead_id, sender_id, status, current_node_id, rotation_count, priority, created_by, reply_ignored_before, current_channel)
      values (e.workspace_id, e.sequence_id, seq.head_version, e.pinned_version, e.lead_id, nxt_sender, 'active', coalesce(n->'config'->>'restart_from', g->>'start'), e.rotation_count + 1, e.priority, e.created_by, e.reply_ignored_before,
              (select sn_.provider from outreach_senders sn_ where sn_.id = nxt_sender))
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
        update outreach_enrollments set sender_id = target, current_channel = (select sn_.provider from outreach_senders sn_ where sn_.id = target) where id = e.id;
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

    -- WhatsApp gate (PRD §6.2): branch on a recorded basis; `bases` narrows which bases count
    elsif t = 'require_consent' then
      ch := coalesce(nullif(n->'config'->>'channel','')::outreach_provider_t, (select sn_.provider from outreach_senders sn_ where sn_.id = e.sender_id));
      cons := outreach__consent_active(e.lead_id, ch);
      branch := case when cons.id is not null
                          and (jsonb_typeof(n->'config'->'bases') <> 'array' or jsonb_array_length(n->'config'->'bases') = 0 or (n->'config'->'bases') ? cons.basis::text)
                     then 'has_consent' else 'no_consent' end;
      nid := coalesce(n->'branches'->>branch, n->>'next'); continue;

    -- Instagram (PRD §9.3): a follow-back is detected by the followers poll (lss.relation = first); the first message waits 2 h after detection
    elsif t = 'wait_follow_back' then
      select relation into rel from outreach_lead_sender_state where lead_id = e.lead_id and sender_id = e.sender_id;
      if rel = 'first' then
        nid := coalesce(n->'branches'->>'followed_back', n->>'next');
        p_not_before := greatest(coalesce(p_not_before, now()), now() + interval '2 hours');
        continue;
      end if;
      update outreach_enrollments set status = 'waiting_connection', wait_until = now() + make_interval(days => coalesce((n->'config'->>'window_days')::int, 5)) where id = e.id;
      return;

    -- a reply advances on `replied` (trigger); the window closing takes `no_reply` (release_waits)
    elsif t = 'wait_for_reply' then
      update outreach_enrollments set status = 'waiting_delay',
             wait_until = greatest(now() + make_interval(hours => coalesce((n->'config'->>'window_hours')::int, 96)), coalesce(p_not_before, now()))
       where id = e.id;
      return;

    -- move the lead to a pool sender of another channel (PRD §9.4); anything missing → `unavailable`
    elsif t = 'channel_switch' then
      target := null;
      ch := nullif(n->'config'->>'to_channel','')::outreach_provider_t;
      select sn_.provider into cur_prov from outreach_senders sn_ where sn_.id = e.sender_id;
      if ch is not null and ch is distinct from cur_prov then
        ident := outreach_lead_identity(e.lead_id, ch);
        select * into caps from outreach_channel_capabilities where provider = ch;
        if (ident is not null or not coalesce((n->'config'->>'require_identity')::boolean, true))
           and (not coalesce((caps.consent->>'required_for_first_contact')::boolean, false) or outreach_lead_has_consent(e.lead_id, ch)) then
          select sn_.id into target
            from jsonb_array_elements_text(case when jsonb_typeof(seq.sender_pools->ch::text) = 'array' then seq.sender_pools->ch::text else '[]'::jsonb end) p(sid)
            join outreach_senders sn_ on sn_.id = p.sid::uuid
           where sn_.provider = ch and sn_.status = 'ok' and sn_.deleted_at is null and sn_.id <> e.sender_id
             and not exists (select 1 from outreach_enrollments x where x.lead_id = e.lead_id and x.sender_id = sn_.id and x.status in ('active','waiting_connection','waiting_delay','waiting_task','paused'))
           order by (select count(*) from outreach_enrollments x2 where x2.sender_id = sn_.id and x2.status in ('active','waiting_connection','waiting_delay','waiting_task')), sn_.id
           limit 1;
        end if;
      end if;
      if target is null then
        nid := coalesce(n->'branches'->>'unavailable', n->>'next'); continue;
      end if;
      update outreach_enrollments set sender_id = target, current_channel = ch, channel_sender_map = coalesce(channel_sender_map, '{}'::jsonb) || jsonb_build_object(ch::text, target) where id = e.id;
      insert into outreach_lead_sender_state(lead_id, sender_id) values (e.lead_id, target) on conflict do nothing;
      e.sender_id := target;
      nid := n->>'next'; continue;

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

-- -----------------------------------------------------------------------------
-- Periodic releaser (011 + reply windows and follow-back windows)
-- -----------------------------------------------------------------------------
create or replace function outreach_release_waits() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare r record; cnt int := 0;
begin
  for r in select e.id, e.current_node_id from outreach_enrollments e
            join outreach_sequences s on s.id = e.sequence_id
           where e.status = 'waiting_delay' and e.wait_until <= now() and s.status = 'active'
             and (outreach__enr_graph(e.id)->'nodes'->e.current_node_id->>'type') = 'delay'
           limit 500 loop
    perform outreach_advance_enrollment(r.id, r.current_node_id, null);
    cnt := cnt + 1;
  end loop;
  -- reply window closed → no_reply
  for r in select e.id, e.current_node_id from outreach_enrollments e
            join outreach_sequences s on s.id = e.sequence_id
           where e.status = 'waiting_delay' and e.wait_until <= now() and s.status = 'active'
             and (outreach__enr_graph(e.id)->'nodes'->e.current_node_id->>'type') = 'wait_for_reply'
           limit 500 loop
    perform outreach_advance_enrollment(r.id, r.current_node_id, 'no_reply');
    cnt := cnt + 1;
  end loop;
  -- connection / follow-back window closed
  for r in select e.id, e.current_node_id, (outreach__enr_graph(e.id)->'nodes'->e.current_node_id->>'type') as ntype from outreach_enrollments e
            join outreach_sequences s on s.id = e.sequence_id
           where e.status = 'waiting_connection' and e.wait_until <= now() and s.status = 'active'
           limit 500 loop
    perform outreach_advance_enrollment(r.id, r.current_node_id, case when r.ntype = 'wait_follow_back' then 'no_follow_back' else 'no_connect' end);
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
-- Relation → first: `followed_back` when the lead waits in wait_follow_back, else `connected` (both +2 h)
-- -----------------------------------------------------------------------------
create or replace function outreach_trg_relation() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare r record; ws uuid; ntype text;
begin
  if new.relation = 'first' and coalesce(old.relation::text,'none') <> 'first' then
    select workspace_id into ws from outreach_senders where id = new.sender_id;
    for r in select e.id, e.current_node_id, e.sequence_id from outreach_enrollments e
              where e.lead_id = new.lead_id and e.sender_id = new.sender_id and e.status = 'waiting_connection' loop
      ntype := outreach__enr_graph(r.id)->'nodes'->r.current_node_id->>'type';
      insert into outreach_node_stats(sequence_id, node_id, variant_id, accepted) values (r.sequence_id, r.current_node_id, '', 1)
        on conflict (sequence_id, node_id, variant_id) do update set accepted = outreach_node_stats.accepted + 1, updated_at = now();
      perform outreach_advance_enrollment(r.id, r.current_node_id, case when ntype = 'wait_follow_back' then 'followed_back' else 'connected' end, now() + interval '2 hours');
    end loop;
    if new.invite_sent_at is not null and old.relation = 'pending_out' then
      perform outreach_emit_event(ws, 'invite.accepted', jsonb_build_object('lead_id', new.lead_id, 'sender_id', new.sender_id, 'detected_at', coalesce(new.invite_detected_at, now())));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists outreach_lss_relation on outreach_lead_sender_state;
create trigger outreach_lss_relation after update of relation on outreach_lead_sender_state
  for each row execute function outreach_trg_relation();

-- -----------------------------------------------------------------------------
-- Reply → stop the lead everywhere (011: hold mode, reply_ignored_before, send_always, queued actions) +
--   channel per provider · wait_for_reply advances on `replied` · channel_independent_continuation stops one channel only
-- -----------------------------------------------------------------------------
create or replace function outreach_trg_reply_exit() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare r record; n jsonb; ws uuid; ch text; at_ts timestamptz; prov outreach_provider_t;
begin
  if not (new.replied and (not coalesce(old.replied, false) or new.last_inbound_at is distinct from old.last_inbound_at)) then return new; end if;
  select workspace_id, provider into ws, prov from outreach_senders where id = new.sender_id;
  ch := outreach__channel_of(prov);
  at_ts := coalesce(new.last_inbound_at, now());
  update outreach_leads set last_replied_at = greatest(coalesce(last_replied_at, at_ts), at_ts), last_replied_channel = ch where id = new.lead_id;

  for r in select e.id, e.sender_id, e.current_node_id, e.sequence_id, e.status, e.paused_from, e.wait_until, e.held_at, e.created_at, e.reply_ignored_before, s.settings,
                  coalesce(e.current_channel, sx.provider) as channel
             from outreach_enrollments e join outreach_sequences s on s.id = e.sequence_id join outreach_senders sx on sx.id = e.sender_id
            where e.lead_id = new.lead_id and e.workspace_id = ws
              and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
    if coalesce((r.settings->>'stop_on_reply')::boolean, true) = false then continue; end if;
    if coalesce(r.settings->>'stop_on_reply_scope','lead') = 'sender' and r.sender_id <> new.sender_id then continue; end if;
    if at_ts < coalesce(r.reply_ignored_before, r.created_at) then continue; end if;   -- backfilled history older than this enrollment
    if r.held_at is not null then continue; end if;
    -- channel-independent continuation (off by default; the validator warns): only the channel that answered stops
    if coalesce((r.settings->>'channel_independent_continuation')::boolean, false) and r.channel is distinct from prov then continue; end if;
    n := outreach__enr_graph(r.id)->'nodes'->r.current_node_id;
    if coalesce((n->'config'->>'send_always')::boolean, false) then continue; end if;
    if (n->>'type') = 'wait_for_reply' and r.status in ('active','waiting_connection','waiting_delay','waiting_task') then
      -- the step was waiting for exactly this: count it and continue on `replied` (the reply no longer blocks later steps)
      insert into outreach_node_stats(sequence_id, node_id, variant_id, replied) values (r.sequence_id, r.current_node_id, '', 1)
        on conflict (sequence_id, node_id, variant_id) do update set replied = outreach_node_stats.replied + 1, updated_at = now();
      update outreach_enrollments set reply_ignored_before = at_ts + interval '1 second' where id = r.id;
      perform outreach_advance_enrollment(r.id, r.current_node_id, 'replied');
      continue;
    end if;
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

-- -----------------------------------------------------------------------------
-- Planner demand (011 + provider, new_chat vs message, consent, quiet period, channel-specific steps)
-- -----------------------------------------------------------------------------
drop function if exists outreach_planner_demand(uuid, timestamptz);
create or replace function outreach_planner_demand(p_sender uuid, p_until timestamptz)
returns table(enrollment_id uuid, lead_id uuid, sequence_id uuid, node_id text, node jsonb, action_type outreach_action_type_t,
              earliest timestamptz, priority int, created_at timestamptz, needs_profile boolean, subtask boolean, settings jsonb, variant_id text, needs_posts boolean,
              provider outreach_provider_t)
language plpgsql stable security definer set search_path = public, extensions as $$
declare r record; n jsonb; subs jsonb; k int; last_sub timestamptz; st jsonb; g jsonb; cfg jsonb; sn outreach_senders%rowtype; quiet boolean; has_chat boolean; ident jsonb;
begin
  select * into sn from outreach_senders where id = p_sender;
  if not found then return; end if;
  quiet := sn.outreach_allowed_from is not null and sn.outreach_allowed_from > now();
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
      if quiet then continue; end if;   -- subtasks are outbound
      select count(*), max(a.created_at) into k, last_sub from outreach_actions a where a.enrollment_id = r.id and a.node_id = r.current_node_id and coalesce((a.payload->>'subtask')::boolean,false);
      if k >= jsonb_array_length(subs) then continue; end if;
      if last_sub is not null and last_sub > now() - interval '2 days' then continue; end if;
      st := subs->k;
      if (st->>'type') not in ('visit_profile','like_latest_post') then continue; end if;
      enrollment_id := r.id; lead_id := r.lead_id; sequence_id := r.sequence_id; node_id := r.current_node_id;
      node := st || jsonb_build_object('id', r.current_node_id, 'subtask_index', k);
      action_type := outreach_node_action_type(st->>'type');
      earliest := greatest(coalesce(last_sub, r.node_entered_at) + interval '2 days', now());
      priority := r.priority; created_at := r.created_at; needs_profile := false; subtask := true; settings := r.settings; variant_id := null; provider := sn.provider;
      needs_posts := (st->>'type') = 'like_latest_post';
      return next;
      continue;
    end if;
    if (n->>'type') = 'delay' or not outreach_is_executable_node(n->>'type') then continue; end if;
    if exists (select 1 from outreach_actions a where a.enrollment_id = r.id and a.node_id = r.current_node_id and a.status in ('queued','reserved')
               and not coalesce((a.payload->>'prefetch')::boolean,false)) then continue; end if;
    cfg := outreach_node_config_for(r.id, n);
    -- a step pinned to another channel is not this sender's to run
    if nullif(cfg->>'channel','') is not null and upper(cfg->>'channel') <> sn.provider::text then continue; end if;
    enrollment_id := r.id; lead_id := r.lead_id; sequence_id := r.sequence_id; node_id := r.current_node_id;
    node := jsonb_set(n, '{config}', cfg);
    variant_id := cfg->>'variant_id';
    action_type := outreach_node_action_type(n->>'type');
    if (n->>'type') in ('send_message','send_voice_note') then
      has_chat := exists (select 1 from outreach_lead_sender_state x where x.lead_id = r.lead_id and x.sender_id = p_sender and x.unipile_chat_id is not null)
                  or exists (select 1 from outreach_chats c where c.lead_id = r.lead_id and c.sender_id = p_sender);
      -- no conversation yet: this step starts one (new_chat) when allowed; otherwise it stays `message` and the executor takes `no_chat`
      if not has_chat and coalesce((cfg->>'new_chat_allowed')::boolean, true) then action_type := 'new_chat'; end if;
    end if;
    -- WhatsApp gate (PRD §6.2): no recorded basis, no new chat (the TypeScript planner reports "Waiting for consent")
    if sn.provider = 'WHATSAPP' and action_type = 'new_chat' and not outreach_lead_has_consent(r.lead_id, 'WHATSAPP') then continue; end if;
    -- quiet period after connecting: nothing outbound
    if quiet and outreach__is_outbound_type(action_type) then continue; end if;
    earliest := coalesce(r.wait_until, r.node_entered_at);
    priority := r.priority; created_at := r.created_at; subtask := false; settings := r.settings; provider := sn.provider;
    if sn.provider = 'LINKEDIN' then
      needs_profile := (n->>'type') in ('send_invite','send_message','send_voice_note','send_inmail','comment_latest_post','like_latest_post','endorse_skills','follow_profile')
                       and (r.provider_id is null or r.last_profile_fetch_at is null or r.last_profile_fetch_at < now() - interval '7 days');
    elsif sn.provider = 'INSTAGRAM' then
      ident := outreach_lead_identity(r.lead_id, 'INSTAGRAM');
      needs_profile := (ident->>'provider_id') is null;   -- the profile read fills the messaging id
    else
      needs_profile := false;
    end if;
    -- posts are fetched only when something will use them (item 13)
    needs_posts := (n->>'type') in ('like_latest_post','comment_latest_post','like_recent_posts','comment_post')
                   or position('enrich.recent_post' in cfg::text) > 0
                   or exists (select 1 from outreach_ai_variables av join outreach_sequences q on q.id = r.sequence_id and q.workspace_id = av.workspace_id
                              where av.needs_posts and cfg::text ~ ('\{\{\s*ai\.' || av.key || '\M'));
    return next;
  end loop;
end $$;
revoke execute on function outreach_planner_demand(uuid,timestamptz) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Blacklists: a stop request suppresses the number / handle (kinds phone, handle) — 012 + the two identity kinds
-- -----------------------------------------------------------------------------
create or replace function outreach_lead_suppression_reason(p_lead outreach_leads, p_client uuid default null, p_sequence uuid default null) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case
    when p_lead.do_not_contact then 'do_not_contact'
    when p_lead.unsubscribed then 'unsubscribed'
    else (
      select case when sp.sequence_id is not null then 'sequence' when sp.client_id is not null then 'client' else 'workspace' end || '_blacklist:' || sp.kind
        from outreach_suppressions sp
       where sp.workspace_id = p_lead.workspace_id
         and (sp.client_id is null or sp.client_id = coalesce(p_client, p_lead.client_id))
         and (sp.sequence_id is null or sp.sequence_id = p_sequence)
         and (
           (sp.kind = 'public_identifier' and p_lead.public_identifier is not null and sp.value = p_lead.public_identifier) or
           (sp.kind = 'email' and ((p_lead.email_work is not null and sp.value = p_lead.email_work) or (p_lead.email_personal is not null and sp.value = p_lead.email_personal))) or
           (sp.kind = 'domain' and ((p_lead.email_work is not null and lower(split_part(p_lead.email_work::text,'@',2)) = lower(sp.value::text)) or
                                    (p_lead.email_personal is not null and lower(split_part(p_lead.email_personal::text,'@',2)) = lower(sp.value::text)))) or
           (sp.kind = 'company' and ((p_lead.company is not null and (lower(trim(p_lead.company)) = lower(sp.value::text)
                                        or outreach_slugify(p_lead.company) = outreach_slugify(sp.value::text)))
                                     or (p_lead.company_id is not null and p_lead.company_id = sp.value::text))) or
           (sp.kind = 'phone' and exists (select 1 from outreach_lead_identities li_ where li_.lead_id = p_lead.id and li_.provider = 'WHATSAPP' and li_.identifier = sp.value)) or
           (sp.kind = 'handle' and exists (select 1 from outreach_lead_identities li_ where li_.lead_id = p_lead.id and li_.provider = 'INSTAGRAM' and li_.identifier = sp.value))
         )
       order by (sp.sequence_id is not null) desc, (sp.client_id is not null) desc limit 1)
  end
$$;

-- -----------------------------------------------------------------------------
-- Enrolment plan (012 + identity per channel, WhatsApp consent). One plan feeds the preview and the commit.
-- -----------------------------------------------------------------------------
create or replace function outreach__enroll_plan(p_sequence uuid, p_lead_ids uuid[], p_sender uuid, p_include_replied boolean)
returns table(lead_id uuid, sender_id uuid, reason text, note text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; l outreach_leads; pool uuid[]; n int; i int := 0; offs int; lid uuid; chosen uuid; rr uuid; tries int; why text;
        load jsonb := '{}'; k text; busy uuid[]; hist uuid[]; free uuid[]; prov jsonb := '{}'; has_msg boolean; fit uuid[]; fit2 uuid[];
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  pool := s.sender_pool;
  if p_sender is not null then
    if not (p_sender = any(pool)) then raise exception 'E_SENDER_NOT_IN_POOL'; end if;
    pool := array[p_sender];
  end if;
  select coalesce(array_agg(x.id order by array_position(pool, x.id)), '{}') into pool from outreach_senders x where x.id = any(pool) and x.deleted_at is null and x.status <> 'disabled';
  n := coalesce(array_length(pool,1),0);
  if n = 0 then raise exception 'E_POOL_EMPTY'; end if;
  select count(*) into offs from outreach_enrollments where sequence_id = p_sequence;
  for k in select unnest(pool)::text loop
    load := load || jsonb_build_object(k, (select count(*) from outreach_enrollments e where e.sender_id = k::uuid and e.status in ('active','waiting_connection','waiting_delay','waiting_task')));
    prov := prov || jsonb_build_object(k, (select sn_.provider::text from outreach_senders sn_ where sn_.id = k::uuid));
  end loop;
  has_msg := exists (select 1 from jsonb_each(s.graph->'nodes') nd where nd.value->>'type' in ('send_message','send_voice_note'));

  foreach lid in array p_lead_ids loop
    lead_id := lid; sender_id := null; reason := null; note := null; chosen := null;
    select * into l from outreach_leads x where x.id = lid and x.workspace_id = s.workspace_id;
    if not found then reason := 'not_in_workspace'; return next; continue; end if;
    why := outreach_lead_suppression_reason(l, s.client_id, s.id);
    if why is not null then reason := 'suppressed:' || why; return next; continue; end if;
    if not p_include_replied and l.last_replied_at is not null and l.last_replied_at > now() - interval '90 days' then
      reason := 'replied_recently'; return next; continue;
    end if;
    select coalesce(array_agg(e.sender_id), '{}') into busy from outreach_enrollments e where e.lead_id = lid and e.sender_id = any(pool) and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused');
    select coalesce(array_agg(h.sender_id order by greatest(coalesce(h.last_outbound_at,'epoch'), coalesce(h.last_inbound_at,'epoch'), coalesce(h.invite_sent_at,'epoch')) desc), '{}') into hist
      from outreach_lead_sender_state h where h.lead_id = lid and h.sender_id = any(pool) and (h.last_outbound_at is not null or h.last_inbound_at is not null or h.invite_sent_at is not null);
    select coalesce(array_agg(x), '{}') into free from unnest(pool) x where not (x = any(busy));
    if array_length(free,1) is null then reason := 'already_enrolled'; return next; continue; end if;
    -- a sender can only reach a lead it has an identity for on its channel (PRD §8.2: no cross-channel guessing)
    select coalesce(array_agg(x), '{}') into fit from unnest(free) x where outreach_lead_identity(lid, (prov->>x::text)::outreach_provider_t) is not null;
    if array_length(fit,1) is null then reason := 'no_identity'; return next; continue; end if;
    -- a WhatsApp sender needs a recorded consent basis before a message step (PRD §6.2)
    select coalesce(array_agg(x), '{}') into fit2 from unnest(fit) x where not (has_msg and (prov->>x::text) = 'WHATSAPP' and not outreach_lead_has_consent(lid, 'WHATSAPP'));
    if array_length(fit2,1) is null then reason := 'no_consent'; return next; continue; end if;
    free := fit2;

    rr := null;
    for tries in 0..n-1 loop
      if pool[((offs + i + tries) % n) + 1] = any(free) then rr := pool[((offs + i + tries) % n) + 1]; exit; end if;
    end loop;

    if p_sender is not null then
      chosen := rr;
    elsif s.assignment = 'fresh_sender' then
      if rr is not null and not (rr = any(hist)) then chosen := rr;
      else
        select x into chosen from unnest(free) x where not (x = any(hist)) order by (load->>x::text)::int, x limit 1;
        if chosen is null then reason := 'no_fresh_sender'; return next; continue; end if;
        note := 'moved_to_fresh_sender';
      end if;
    elsif s.assignment = 'same_sender' then
      select x into chosen from unnest(hist) x where x = any(free) limit 1;
      if chosen is not null then note := case when chosen = rr then null else 'kept_with_previous_sender' end; else chosen := rr; end if;
    elsif s.assignment = 'least_loaded' then
      select x into chosen from unnest(free) x order by (load->>x::text)::int, x limit 1;
    else
      chosen := rr;
    end if;
    if chosen is null then reason := 'already_enrolled'; return next; continue; end if;
    if note is null and chosen = any(hist) then note := 'contacted_before_by_this_sender'; end if;
    load := jsonb_set(load, array[chosen::text], to_jsonb(coalesce((load->>chosen::text)::int, 0) + 1));
    sender_id := chosen; i := i + 1;
    return next;
  end loop;
end $$;
revoke execute on function outreach__enroll_plan(uuid,uuid[],uuid,boolean) from public, anon, authenticated;

-- 012 + current_channel = the sender's provider
create or replace function outreach_enroll_leads(p_sequence uuid, p_lead_ids uuid[], p_sender uuid default null, p_priority int default 100,
                                                 p_include_replied boolean default false, p_rule uuid default null, p_wait_enrichment boolean default null)
returns table(enrolled int, skipped_active int, skipped_suppressed int, skipped_other int, skipped_replied int, waiting int)
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; p record; eid uuid; keys text[]; want_wait boolean; hold_ai boolean; st outreach_enrollment_status_t; wr text; enriched timestamptz; want_posts boolean;
begin
  enrolled := 0; skipped_active := 0; skipped_suppressed := 0; skipped_other := 0; skipped_replied := 0; waiting := 0;
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if exists (select 1 from outreach_leads ld_ where ld_.id = any(p_lead_ids) and not outreach_client_visible(s.workspace_id, ld_.client_id)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if array_length(p_lead_ids,1) > 10000 then raise exception 'E_TOO_MANY: max 10000 per request'; end if;
  keys := outreach_sequence_ai_keys(s.graph);
  want_wait := coalesce(p_wait_enrichment, (s.settings->>'wait_for_enrichment')::boolean, false);
  hold_ai := coalesce((s.settings->>'hold_for_ai_review')::boolean, false) and array_length(keys,1) > 0;
  want_posts := position('enrich.recent_post' in s.graph::text) > 0
                or exists (select 1 from outreach_ai_variables v where v.workspace_id = s.workspace_id and v.key = any(keys) and v.needs_posts);

  for p in select * from outreach__enroll_plan(p_sequence, p_lead_ids, p_sender, p_include_replied) loop
    if p.sender_id is null then
      if p.reason like 'suppressed:%' then skipped_suppressed := skipped_suppressed + 1;
      elsif p.reason = 'replied_recently' then skipped_replied := skipped_replied + 1;
      elsif p.reason in ('already_enrolled') then skipped_active := skipped_active + 1;
      else skipped_other := skipped_other + 1; end if;
      continue;
    end if;
    st := 'active'; wr := null;
    if want_wait then
      select enriched_at into enriched from outreach_lead_profiles where lead_id = p.lead_id;
      if enriched is null or enriched < now() - interval '90 days' then st := 'waiting_task'; wr := 'enrichment'; end if;
    end if;
    if wr is null and hold_ai then
      perform outreach_ensure_ai_values(s.workspace_id, p.lead_id, keys, null);
      if exists (select 1 from outreach_ai_variables v left join outreach_ai_values x on x.variable_id = v.id and x.lead_id = p.lead_id
                  where v.workspace_id = s.workspace_id and v.key = any(keys) and coalesce(x.status,'pending') in ('pending','generated')) then
        st := 'waiting_task'; wr := 'ai_review';
      end if;
    end if;
    insert into outreach_lead_sender_state(lead_id, sender_id) values (p.lead_id, p.sender_id) on conflict do nothing;
    update outreach_lead_sender_state set replied = false where lead_id = p.lead_id and sender_id = p.sender_id and replied;
    eid := null;
    insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, wait_reason, current_node_id, priority, created_by, rule_id, current_channel)
    values (s.workspace_id, p_sequence, s.head_version, p.lead_id, p.sender_id, st, wr, s.graph->>'start', p_priority, auth.uid(), p_rule,
            (select sn_.provider from outreach_senders sn_ where sn_.id = p.sender_id))
    on conflict do nothing returning id into eid;
    if eid is null then skipped_active := skipped_active + 1; continue; end if;
    enrolled := enrolled + 1;
    perform outreach_emit_event(s.workspace_id, 'enrollment.started', jsonb_build_object('id', eid, 'lead_id', p.lead_id, 'sender_id', p.sender_id, 'sequence_id', p_sequence, 'rule_id', p_rule));
    if wr = 'enrichment' then
      waiting := waiting + 1;
      update outreach_leads set enrich_status = 'waiting' where id = p.lead_id;
      insert into outreach_enrich_queue(lead_id, workspace_id, want_posts, requested_by, reason) values (p.lead_id, s.workspace_id, want_posts, auth.uid(), 'enrollment')
      on conflict (lead_id) do update set want_posts = outreach_enrich_queue.want_posts or excluded.want_posts, next_at = least(outreach_enrich_queue.next_at, now());
    elsif wr = 'ai_review' then
      waiting := waiting + 1;
    else
      perform outreach_enter_node(eid, s.graph->>'start');
    end if;
  end loop;
  return next;
end $$;

-- -----------------------------------------------------------------------------
-- Validator (020 + channel rules). The channel of a step: its config.channel, its inherent channel, or the pool's only
-- messaging provider; null = any (mixed pool, no explicit channel).
-- -----------------------------------------------------------------------------
create or replace function outreach__node_channel(p_node jsonb, p_pool_provs text[]) returns text
language plpgsql immutable as $$
declare t text := p_node->>'type'; c text := nullif(p_node->'config'->>'channel',''); np text[] := coalesce(p_pool_provs, '{}'); msg text[];
begin
  if t = 'channel_switch' then return upper(nullif(p_node->'config'->>'to_channel','')); end if;
  if c is not null then return upper(c); end if;
  if t in ('follow','unfollow','like_recent_posts','comment_post','wait_follow_back') then return 'INSTAGRAM'; end if;
  if t in ('check_identifier','require_consent') then return 'WHATSAPP'; end if;
  if t in ('visit_profile','refresh_profile','like_latest_post','comment_latest_post','endorse_skills','follow_profile','send_invite','withdraw_invite','send_inmail','wait_connection') then return 'LINKEDIN'; end if;
  if t = 'send_email' then return 'EMAIL'; end if;
  if t in ('send_message','send_voice_note') then
    select array_agg(p) into msg from unnest(np) p where p in ('LINKEDIN','INSTAGRAM','WHATSAPP');
    if coalesce(array_length(msg,1),0) = 1 then return msg[1]; end if;
    if coalesce(array_length(np,1),0) = 0 then return 'LINKEDIN'; end if;   -- no pool yet: LinkedIn rules, as before
    return null;
  end if;
  return null;
end $$;

create or replace function outreach_validate_graph(p_graph jsonb, p_pool uuid[] default '{}', p_strict boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  errors jsonb := '[]'; warnings jsonb := '[]';
  nodes jsonb; k text; n jsonb; t text; nxt text; b record; v jsonb; texts jsonb; tx text; ids text[];
  has_free boolean := false; has_mailbox boolean := false;
  has_connect_path boolean := false; has_terminal boolean := false;
  note_limit int; visited text[] := '{}'; queue text[]; cur text; lim int; ml int;
  pool_provs text[] := '{}'; nch text; has_li_msg boolean := false; has_wa_step boolean := false;
  unguarded text[] := '{}'; q2 text[]; anc text[]; changed boolean; ak text; av jsonb; run int; best jsonb := '{}'; hourly_flagged boolean := false; nn jsonb; ntype text;
  first_exec text[] := '{}'; cur2 text; parts text[];
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
    select bool_or(not is_premium) filter (where provider = 'LINKEDIN'), bool_or(provider in ('GMAIL','OUTLOOK','IMAP')), coalesce(array_agg(distinct provider::text), '{}')
      into has_free, has_mailbox, pool_provs from outreach_senders where id = any(p_pool);
  end if;
  note_limit := case when coalesce(has_free,false) then 200 else 300 end;

  -- the paths from start that avoid every "Check consent" step: a WhatsApp message on one of them is unguarded
  q2 := array[p_graph->>'start'];
  while array_length(q2,1) > 0 loop
    cur := q2[1]; q2 := q2[2:];
    if cur is null or cur = any(unguarded) or not (nodes ? cur) then continue; end if;
    unguarded := unguarded || cur;
    nn := nodes->cur;
    if (nn->>'type') = 'require_consent' then
      if nn->'branches'->>'no_consent' is not null then q2 := q2 || (nn->'branches'->>'no_consent'); end if;
      if nn->>'next' is not null then q2 := q2 || (nn->>'next'); end if;
      continue;
    end if;
    if nn->>'next' is not null then q2 := q2 || (nn->>'next'); end if;
    if nn ? 'branches' and jsonb_typeof(nn->'branches') = 'object' then
      for b in select * from jsonb_each_text(nn->'branches') loop q2 := q2 || b.value; end loop;
    end if;
  end loop;

  -- the first executable step(s) reached from start (through passive nodes)
  q2 := array[p_graph->>'start']; visited := '{}';
  while array_length(q2,1) > 0 loop
    cur := q2[1]; q2 := q2[2:];
    if cur is null or cur = any(visited) or not (nodes ? cur) then continue; end if;
    visited := visited || cur;
    nn := nodes->cur;
    if outreach_is_executable_node(nn->>'type') then first_exec := first_exec || cur; continue; end if;
    if nn->>'next' is not null then q2 := q2 || (nn->>'next'); end if;
    if nn ? 'branches' and jsonb_typeof(nn->'branches') = 'object' then
      for b in select * from jsonb_each_text(nn->'branches') loop q2 := q2 || b.value; end loop;
    end if;
  end loop;
  visited := '{}';

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
    if t = 'condition' and outreach_condition_proves_connection(n) then has_connect_path := true; end if;
    nch := outreach__node_channel(n, pool_provs);
    if nch = 'WHATSAPP' then has_wa_step := true; end if;
    if t in ('send_message','send_voice_note') and not coalesce((n->'config'->>'send_always')::boolean,false)
       and (nch = 'LINKEDIN' or (nch is null and 'LINKEDIN' = any(pool_provs))) then has_li_msg := true; end if;

    -- every text the step can send: the base copy plus each variant (longest spintax combination is what counts)
    texts := '[]'::jsonb;
    if t in ('send_invite','send_message','send_inmail','send_email','comment_latest_post','comment_post') then
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
      lim := case t when 'send_invite' then note_limit
                    when 'send_message' then (case nch when 'INSTAGRAM' then 1000 when 'WHATSAPP' then 4096 else 8000 end)
                    when 'comment_latest_post' then 1250 when 'comment_post' then 2200 when 'send_inmail' then 1900 else null end;
      for v in select * from jsonb_array_elements(texts) loop
        tx := v->>'text';
        if jsonb_array_length(texts) > 1 and v->>'label' = '' and tx = '' then continue; end if;   -- variants replace an empty base copy
        ml := outreach_template_max_len(tx);
        if lim is not null and ml > lim then
          errors := errors || jsonb_build_object('node_id', k, 'code', case when t = 'send_invite' then 'E_NOTE_TOO_LONG' else 'E_PAYLOAD_INVALID' end,
            'message', case t when 'send_invite' then 'invite note' when 'send_message' then 'message' when 'comment_latest_post' then 'comment' when 'comment_post' then 'comment' else 'InMail body' end
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
    if t in ('send_invite','send_message','comment_latest_post','send_inmail','comment_post') and (n->'config'->'ai') is not null and (n->'config'->'ai'->>'brief') is null then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_AI_BRIEF','message','AI drafting enabled without a brief');
    end if;
    if t = 'send_voice_note' and p_strict then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_VOICE_CLIP','message','each pool sender needs a recorded clip for this step; senders without one skip it');
    end if;

    -- channel rules (PRD §9.5)
    if t in ('send_message','send_voice_note') and nch = 'WHATSAPP' and coalesce((n->'config'->>'new_chat_allowed')::boolean, true) and k = any(unguarded) then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_NO_CONSENT_GUARD','message','A WhatsApp message that may start a new chat needs a "Check consent" step before it');
    end if;
    if t = 'like_recent_posts' and coalesce((n->'config'->>'count')::int, 1) > 3 then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_LIKE_COUNT','message','Like at most 3 recent posts in one step');
    end if;
    if p_strict and nch in ('INSTAGRAM','WHATSAPP','LINKEDIN') and t <> 'send_message' and t <> 'send_voice_note' and nch <> 'LINKEDIN' and not (nch = any(pool_provs)) then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_NO_CHANNEL_SENDER','message', format('This step runs on %s, but the sender pool has no %s account', outreach__provider_label(nch::outreach_provider_t), outreach__provider_label(nch::outreach_provider_t)));
    elsif p_strict and t in ('send_message','send_voice_note','channel_switch') and nch in ('INSTAGRAM','WHATSAPP','LINKEDIN') and not (nch = any(pool_provs)) and nullif(coalesce(n->'config'->>'channel', n->'config'->>'to_channel'),'') is not null then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_NO_CHANNEL_SENDER','message', format('This step needs a %s account in the sender pool', outreach__provider_label(nch::outreach_provider_t)));
    end if;
    if t = 'wait_follow_back' and not (coalesce(n->'branches','{}'::jsonb) ? 'followed_back') then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_BRANCH_MISSING','message','"Wait for follow-back" should define what happens when they follow back');
    end if;
    if t = 'wait_for_reply' and not (coalesce(n->'branches','{}'::jsonb) ? 'replied') then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_BRANCH_MISSING','message','"Wait for reply" should define what happens when they reply');
    end if;
    if t = 'require_consent' and not (coalesce(n->'branches','{}'::jsonb) ? 'has_consent') then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_BRANCH_MISSING','message','"Check consent" should define what happens when consent is recorded');
    end if;
    if t = 'check_identifier' and not (coalesce(n->'branches','{}'::jsonb) ? 'valid') then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_BRANCH_MISSING','message','"Check the number" should define what happens when the number is on WhatsApp');
    end if;
    if t = 'require_consent' and jsonb_typeof(n->'config'->'bases') = 'array' and n->'config'->'bases' = '["imported_attested"]'::jsonb then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_WA_ATTESTED_ONLY','message','This step accepts only imported attestations, the weakest consent basis. Prefer inbound or explicit bases');
    end if;
    if t = 'comment_post' and coalesce(n->'config'->>'text','') ~* '(book a|demo|pricing|our (product|platform|tool)|sign up|free trial|dm me|link in bio)' then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_IG_COMMENT_PITCH','message','This comment reads like a pitch. Public comments that sell get accounts reported; say something about the post instead');
    end if;
    if t = 'channel_switch' and coalesce((n->'config'->>'require_identity')::boolean, true) then
      anc := array[k]; changed := true;
      while changed loop
        changed := false;
        for ak, av in select * from jsonb_each(nodes) loop
          if ak = any(anc) then continue; end if;
          if (av->>'next') = any(anc) or exists (select 1 from jsonb_each_text(coalesce(av->'branches','{}'::jsonb)) bb where bb.value = any(anc)) then
            anc := anc || ak; changed := true;
          end if;
        end loop;
      end loop;
      if not exists (select 1 from unnest(anc) a2 where a2 <> k and (nodes->a2->>'type') in ('wait_for_reply','wait_connection','manual_task','call_task','refresh_profile','visit_profile','find_email')) then
        warnings := warnings || jsonb_build_object('node_id', k, 'code','E_SWITCH_NO_IDENTITY','message', format('Switching to %s needs a %s on the lead. Nothing before this step can add one, so leads without one on file take the "unavailable" exit',
          case when nch in ('LINKEDIN','INSTAGRAM','WHATSAPP','GMAIL','OUTLOOK','IMAP') then outreach__provider_label(nch::outreach_provider_t) else 'the other channel' end,
          case nch when 'WHATSAPP' then 'phone number' when 'INSTAGRAM' then 'handle' else 'profile' end));
      end if;
    end if;
    if t = 'send_message' and nch = 'INSTAGRAM' and k = any(first_exec) then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_IG_DM_FIRST','message','The first Instagram step is a direct message. A follow, a like and a comment first get several times more replies and keep the account safer');
    end if;
  end loop;

  -- Instagram: more than 10 executable steps in a row without a wait would exceed the hourly ledger (10/hour)
  if 'INSTAGRAM' = any(pool_provs) or exists (select 1 from jsonb_each(nodes) x where outreach__node_channel(x.value, pool_provs) = 'INSTAGRAM') then
    q2 := array[(p_graph->>'start') || '|0'];
    while array_length(q2,1) > 0 and not hourly_flagged loop
      cur2 := q2[1]; q2 := q2[2:];
      parts := string_to_array(cur2, '|');
      cur := parts[1]; run := parts[2]::int;
      if cur is null or not (nodes ? cur) then continue; end if;
      nn := nodes->cur; ntype := nn->>'type';
      if ntype in ('delay','wait_connection','wait_follow_back','wait_for_reply','manual_task','call_task','ai_draft_approval') then run := 0;
      elsif outreach_is_executable_node(ntype) and outreach__node_channel(nn, pool_provs) = 'INSTAGRAM' then
        run := case when nn ? 'delay' and (nn->'delay'->>'amount') is not null then 1 else run + 1 end;
      end if;
      if run > 10 then
        errors := errors || jsonb_build_object('node_id', cur, 'code','E_HOURLY_DEMAND','message','More than 10 Instagram actions in a row without a wait: Instagram allows 10 per hour. Add a delay between them');
        hourly_flagged := true; exit;
      end if;
      if coalesce((best->>cur)::int, -1) >= run then continue; end if;
      best := best || jsonb_build_object(cur, run);
      if nn->>'next' is not null then q2 := q2 || ((nn->>'next') || '|' || run); end if;
      if nn ? 'branches' and jsonb_typeof(nn->'branches') = 'object' then
        for b in select * from jsonb_each_text(nn->'branches') loop q2 := q2 || (b.value || '|' || run); end loop;
      end if;
    end loop;
  end if;

  if coalesce((p_graph->'settings'->>'channel_independent_continuation')::boolean, false) then
    warnings := warnings || jsonb_build_object('code','W_CHANNEL_INDEPENDENT','message','A reply on one channel will not stop the other channels. Leads can be contacted twice; keep this off unless you mean it');
  end if;

  if p_strict then
    if not has_terminal then
      errors := errors || jsonb_build_object('code','E_GRAPH_INVALID','message','no exit path (add an End node)');
    end if;
    if has_li_msg and not has_connect_path then
      errors := errors || jsonb_build_object('code','E_RELATION_REQUIRED','message','a message node needs an invite / wait_connection (or InMail) path before it');
    end if;
    if has_wa_step and 'WHATSAPP' = any(pool_provs)
       and not exists (select 1 from outreach_senders sn_ where sn_.id = any(p_pool) and sn_.provider = 'WHATSAPP' and (sn_.outreach_allowed_from is null or sn_.outreach_allowed_from <= now())) then
      errors := errors || jsonb_build_object('code','E_QUIET_PERIOD','message','Every WhatsApp number in the pool is still in its 24-hour quiet period after connecting. Activate later, or add a number that has been connected for a day');
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
-- Reasons in plain words (012 + channel codes)
-- -----------------------------------------------------------------------------
create or replace function outreach_reason_text(p_code text, p_decision text default null) returns text
language sql immutable as $$
  select case
    when p_code is null then 'Unknown reason'
    when p_code in ('E_LEAD_SUPPRESSED','suppressed','do_not_contact','unsubscribed') then 'The lead is on a do-not-contact list'
    when p_code in ('E_REPLIED','replied') then 'The lead replied, so the sequence stopped'
    when p_code in ('E_NO_CONSENT','no_consent') then 'No recorded consent for WhatsApp, so no new chat was started'
    when p_code in ('E_NO_IDENTITY','no_identity') then 'The lead has no handle or number on file for this channel'
    when p_code in ('E_IDENTIFIER_INVALID','not_on_whatsapp') then 'The number is not on WhatsApp'
    when p_code in ('E_HOURLY_CAP','hourly_deferred') then 'The hourly allowance was used; moved to the next hour'
    when p_code = 'E_QUIET_PERIOD' then 'The account is in its quiet period after connecting; outreach starts later'
    when p_code = 'E_MIN_GAP' then 'Waiting for the minimum gap between two actions'
    when p_code = 'E_PROVIDER_WARNING' then 'The provider warned about automated behaviour; the account is paused for a review'
    when p_code = 'no_chat' then 'No conversation exists yet and this step does not start one'
    when p_code = 'no_follow_back' then 'The lead did not follow back within the window'
    when p_code = 'no_reply' then 'The lead did not reply within the window'
    when p_code = 'unavailable' then 'The lead could not be moved to the other channel'
    when p_code = 'consent_revoked' then 'Consent was withdrawn, so the sequence stopped'
    when p_code = 'stop_request' then 'The lead asked to stop, so the sequence stopped'
    when p_code = 'blocked' then 'The lead blocked this account'
    when p_code = 'E_RELATION_INVALID' then 'LinkedIn says this profile cannot be invited (blocked or invalid)'
    when p_code = 'E_RELATION_REQUIRED' or p_code like '%no_connection_with_recipient%' then 'Not connected yet, so a message could not be sent'
    when p_code = 'E_PAYLOAD_INVALID' or p_code like '%payload_invalid%' then 'The step had no usable text for this lead'
    when p_code = 'E_NO_EMAIL' then 'No email address on file'
    when p_code = 'email_bounced' or p_code like '%recipient_rejected%' then 'The email address bounced'
    when p_code = 'E_ENROLLMENT_NOT_LIVE' then 'The lead had already left the sequence'
    when p_code = 'network_timeout_max' or p_code like 'net:%' then 'Could not reach the provider after three tries'
    when p_code like '%invalid_recipient%' or p_code like '%user_unreachable%' or p_code like '404:%' then 'The profile no longer exists or cannot be reached'
    when p_code like '%blocked_recipient%' or p_code like '%cannot_invite_attendee%' then 'This person cannot be contacted (they limit who can reach them)'
    when p_code like '%already_invited_recently%' or p_code like '%cannot_resend%' or p_code = 'invitation_pending' then 'An invitation is already pending or was sent recently'
    when p_code like '%already_connected%' or p_code = 'already_connected' then 'Already connected, so the invitation was skipped'
    when p_code like '%insufficient_credits%' or p_code like '%not_allowed_inmail%' or p_code = 'not_open_profile' then 'No InMail credit for this lead'
    when p_code = 'no_recent_post' then 'The lead has no recent post to react to'
    when p_code = 'no_skills' then 'No skills to endorse on the profile'
    when p_code = 'no_voice_clip' then 'This sender has not recorded a voice note for the step'
    when p_code = 'no_invitation' then 'There was no pending invitation to withdraw'
    when p_code in ('unsupported_follow','unsupported_unfollow') then 'This channel does not support that step, so it was skipped'
    when p_code like '%comments_disabled%' or p_code like '%invalid_post%' then 'The post does not accept comments'
    when p_code like '401:%' or p_code = 'E_SENDER_NOT_OK' then 'The sender was disconnected'
    when p_code like '403:%' then 'The provider restricted the sender for this action'
    when p_code like '429:%' then 'The provider rate-limited the sender'
    when p_code like '5__:%' then 'The provider had a temporary error'
    when p_code like 'http_%' then 'The API call returned ' || replace(p_code, 'http_', 'HTTP ')
    when p_code = 'graph_loop' then 'The sequence loops without a wait'
    when p_code = 'unknown_node_type' then 'The sequence contains a step this version cannot run'
    when p_code = 'user_skipped' then 'Skipped by a teammate'
    when p_code = 'email_not_found' then 'No email address was found'
    else replace(replace(p_code, 'E_', ''), '_', ' ') end
$$;

create or replace function outreach_action_label(p_type text) returns text
language sql immutable as $$
  select case p_type when 'invite' then 'invitations' when 'message' then 'messages' when 'new_chat' then 'new chats' when 'inmail' then 'InMails' when 'email' then 'emails' when 'profile_view' then 'profile views'
    when 'like' then 'likes' when 'comment' then 'comments' when 'endorse' then 'endorsements' when 'follow' then 'follows' when 'unfollow' then 'unfollows' when 'withdraw' then 'withdrawals'
    when 'post_fetch' then 'post look-ups' when 'search_page' then 'search pages' when 'find_email' then 'email look-ups' when 'identifier_check' then 'number checks' when 'followers_poll' then 'follower checks'
    when 'all_metered' then 'actions' else replace(p_type, '_', ' ') end
$$;

-- the action types a sender is expected to have allowance for when the sequence gives no hint
create or replace function outreach__default_need(p outreach_provider_t) returns text[]
language sql immutable as $$
  select case p when 'INSTAGRAM' then array['new_chat','message','follow','like','comment','profile_view']
                when 'WHATSAPP' then array['new_chat','message','identifier_check']
                when 'LINKEDIN' then array['invite','message'] else array['email'] end
$$;

-- -----------------------------------------------------------------------------
-- Diagnosis in the database (013 + quiet period, provider warning, hourly cap, min gap)
-- -----------------------------------------------------------------------------
create or replace function outreach__sender_causes(p_sender uuid, p_need text[]) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; c jsonb := '[]'; plan text; b record; nw timestamptz; d int; w record; wk int; wkc int; nm text; caps outreach_channel_capabilities%rowtype; hb outreach_sender_budgets_scoped%rowtype; gap int; last_at timestamptz; hrs int;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found or s.deleted_at is not null then return jsonb_build_array(jsonb_build_object('code','E_SENDER_NOT_OK','blocking',true,'sender_id',p_sender,'detail','This sender no longer exists','remedy','Remove it from the pool.')); end if;
  nm := coalesce(s.display_name, 'Sender');
  select * into caps from outreach_channel_capabilities where provider = s.provider;
  select w2.plan into plan from outreach_workspaces w2 where w2.id = s.workspace_id;
  if plan = 'suspended' then c := c || jsonb_build_object('code','E_PLAN_SUSPENDED','blocking',true,'sender',nm,'sender_id',s.id,'detail','The workspace is suspended (billing)','remedy','An owner fixes billing; sending resumes on its own afterwards.'); end if;
  if s.status <> 'ok' then
    c := c || jsonb_build_object('code','E_SENDER_NOT_OK','blocking',true,'sender',nm,'sender_id',s.id,
      'detail', nm || case s.status when 'credentials' then ' is disconnected from ' || outreach__provider_label(s.provider) || ' (session expired)' when 'error' then ' reports a provider error (' || coalesce(s.status_reason,'unknown') || ')'
                           when 'paused' then ' is paused (' || coalesce(s.status_reason,'by a teammate') || ')' when 'connecting' then ' is still connecting' else ' is ' || s.status::text end,
      'remedy', case when s.status = 'paused' then 'A manager resumes it on the sender page.' else 'Reconnect it on the sender page.' end);
  end if;
  if s.provider_warning is not null and s.paused_until is not null and s.paused_until > now() and coalesce(s.status_reason,'') = 'provider_warning' then
    c := c || jsonb_build_object('code','E_PROVIDER_WARNING','blocking',true,'sender',nm,'sender_id',s.id,'next_capacity',s.paused_until,
      'detail', nm || ' is paused after a warning from ' || outreach__provider_label(s.provider) || ': "' || coalesce(s.provider_warning->>'text','') || '"',
      'remedy','Read the warning on the sender page. A manager can resume it early; the pause protects the account.');
  elsif s.paused_until is not null and s.paused_until > now() then
    c := c || jsonb_build_object('code','E_SENDER_PAUSED','blocking',true,'sender',nm,'sender_id',s.id,'next_capacity',s.paused_until,
      'detail', nm || ' is resting until ' || to_char(s.paused_until at time zone s.timezone, 'Mon DD HH24:MI') || ' (' || coalesce(s.status_reason,'safety pause') || ')', 'remedy','Wait it out. Do not move volume to other senders to compensate.');
  end if;
  if s.outreach_allowed_from is not null and s.outreach_allowed_from > now() then
    hrs := coalesce((caps.ledger->>'post_connect_quiet_hours')::int, 24);
    c := c || jsonb_build_object('code','E_QUIET_PERIOD','blocking',true,'sender',nm,'sender_id',s.id,'next_capacity',s.outreach_allowed_from,
      'detail', format('%s connected recently and waits until %s before outreach (%s h quiet period)', nm, to_char(s.outreach_allowed_from at time zone s.timezone, 'Mon DD HH24:MI'), hrs),
      'remedy','By design: a number that starts outreach right after connecting looks suspicious. Replies still go out.');
  end if;
  if not outreach_in_schedule(s.id, now()) then
    nw := null;
    for d in 0..7 loop
      for w in select start_at from outreach_schedule_windows(s.id, (now() at time zone s.timezone)::date + d) order by start_at loop
        if w.start_at > now() then nw := w.start_at; exit; end if;
      end loop;
      exit when nw is not null;
    end loop;
    c := c || jsonb_build_object('code', case when nw is null then 'E_NO_SCHEDULE' else 'W_OUT_OF_SCHEDULE' end, 'blocking', nw is null, 'sender',nm,'sender_id',s.id,'next_capacity',nw,
      'detail', case when nw is null then nm || ' has no working hours in the next 7 days' else nm || ' is outside working hours; sending resumes ' || to_char(nw at time zone s.timezone, 'Dy HH24:MI') || ' (' || s.timezone || ')' end,
      'remedy', case when nw is null then 'Set working hours on the sender page.' else 'Nothing to fix.' end);
  end if;
  for b in select x.action_type::text t, x.cap, x.used, x.reserved from outreach_sender_budgets x where x.sender_id = p_sender and x.day = outreach_sender_local_date(p_sender, now()) and x.action_type::text = any(p_need) loop
    if b.cap = 0 then
      if exists (select 1 from outreach_schedule_windows(s.id, outreach_sender_local_date(s.id, now()))) then
        c := c || jsonb_build_object('code','E_CAP_ZERO','blocking',true,'sender',nm,'sender_id',s.id,'detail', format('%s has no allowance for %s today (warm-up level %s, health %s)', nm, outreach_action_label(b.t), s.warmup_level, s.health_score),'remedy','Allowances rise with warm-up level and health. A manager can check the manual caps.');
      end if;
    elsif b.used + b.reserved >= b.cap then
      c := c || jsonb_build_object('code','W_BUDGET_EXHAUSTED','blocking',false,'sender',nm,'sender_id',s.id,'next_capacity','tomorrow','detail', format('%s used today''s allowance for %s (%s of %s)', nm, outreach_action_label(b.t), b.used + b.reserved, b.cap),'remedy','Resumes tomorrow. Add another healthy sender for more volume; do not raise caps.');
    end if;
  end loop;
  -- daily all-actions scope (Instagram)
  if coalesce(jsonb_typeof(caps.ledger->'daily_scope'), 'null') = 'object' then
    select * into hb from outreach_sender_budgets_scoped where sender_id = p_sender and "window" = 'day' and window_start = outreach__day_start(p_sender, outreach_sender_local_date(p_sender, now())) and scope = caps.ledger->'daily_scope'->>'scope';
    if found and hb.used + hb.reserved >= hb.cap and hb.cap > 0 then
      c := c || jsonb_build_object('code','W_BUDGET_EXHAUSTED','blocking',false,'sender',nm,'sender_id',s.id,'next_capacity','tomorrow','detail', format('%s used today''s total allowance (%s of %s actions)', nm, hb.used + hb.reserved, hb.cap),'remedy','Resumes tomorrow. Instagram is a low-volume channel; better targeting beats more actions.');
    end if;
  end if;
  -- hourly scope (Instagram)
  if coalesce(jsonb_typeof(caps.ledger->'hourly'), 'null') = 'object' then
    select * into hb from outreach_sender_budgets_scoped where sender_id = p_sender and "window" = 'hour' and window_start = date_trunc('hour', now()) and scope = caps.ledger->'hourly'->>'scope';
    if found and hb.used + hb.reserved >= hb.cap then
      c := c || jsonb_build_object('code','W_HOURLY_CAP','blocking',false,'sender',nm,'sender_id',s.id,'next_capacity', date_trunc('hour', now()) + interval '1 hour',
        'detail', format('%s used this hour''s allowance (%s of %s actions)', nm, hb.used + hb.reserved, hb.cap),'remedy','Continues next hour. Nothing to fix.');
    end if;
  end if;
  -- minimum gap between actions
  gap := outreach_sender_min_gap(p_sender);
  if gap > 0 then
    select max(a.executed_at) into last_at from outreach_actions a where a.sender_id = p_sender and a.status in ('sent','failed') and a.action_type <> 'reply' and a.executed_at > now() - make_interval(secs => gap);
    if last_at is not null then
      c := c || jsonb_build_object('code','W_MIN_GAP','blocking',false,'sender',nm,'sender_id',s.id,'next_capacity', last_at + make_interval(secs => gap),
        'detail', format('%s acted %s seconds ago; the next action waits for the %s-second gap', nm, extract(epoch from now() - last_at)::int, gap),'remedy','Nothing to fix.');
    end if;
  end if;
  if 'invite' = any(p_need) and outreach__ceiling_provider(s.provider) = 'LINKEDIN' then
    wk := outreach_weekly_invites_used(p_sender, outreach_sender_local_date(p_sender, now()));
    select per_week into wkc from outreach_platform_ceilings where provider = 'LINKEDIN' and action_type = 'invite';
    if wk >= coalesce(wkc,150) then c := c || jsonb_build_object('code','E_CAP_HIT_WEEKLY','blocking',true,'sender',nm,'sender_id',s.id,'detail', format('%s reached the weekly invitation ceiling (%s of %s)', nm, wk, coalesce(wkc,150)),'remedy','Invitations resume next week; messages continue.'); end if;
    if s.invite_blocked_until is not null and s.invite_blocked_until > now() then
      c := c || jsonb_build_object('code','E_INVITE_BLOCKED','blocking',true,'sender',nm,'sender_id',s.id,'next_capacity',s.invite_blocked_until,'detail', nm || ': LinkedIn refused further invitations until ' || to_char(s.invite_blocked_until, 'Mon DD'),'remedy','Wait. Other steps continue.');
    end if;
  end if;
  if s.health_score < 50 then c := c || jsonb_build_object('code','E_HEALTH_PAUSED','blocking',true,'sender',nm,'sender_id',s.id,'detail', format('%s has a health score of %s: below 50 every allowance is 0', nm, s.health_score),'remedy','Open the sender page for the failing category; recovery takes days of low, steady activity.');
  elsif s.health_score < 70 then c := c || jsonb_build_object('code','W_HEALTH_REDUCED','blocking',false,'sender',nm,'sender_id',s.id,'detail', format('%s has a health score of %s: allowances are reduced to 60%%', nm, s.health_score),'remedy','Keep volume steady.'); end if;
  return c;
end $$;
revoke execute on function outreach__sender_causes(uuid,text[]) from public, anon, authenticated;

create or replace function outreach_why_not_sending(p_sequence uuid default null, p_sender uuid default null, p_enrollment uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare causes jsonb := '[]'; notes jsonb := '[]'; ws uuid; target text; q outreach_sequences%rowtype; e outreach_enrollments%rowtype; s outreach_senders%rowtype; l outreach_leads%rowtype;
        need text[]; sid uuid; n jsonb; live int; queued int; waiting int; f record; blocking jsonb; tk record; nx record; rel text; ok_senders int := 0; sc jsonb; first_text text;
        eprov outreach_provider_t; ident jsonb; caps outreach_channel_capabilities%rowtype;
begin
  if p_enrollment is not null then
    select * into e from outreach_enrollments where id = p_enrollment;
    if not found then raise exception 'E_NOT_FOUND'; end if;
    ws := e.workspace_id; p_sequence := e.sequence_id;
  elsif p_sequence is not null then select workspace_id into ws from outreach_sequences where id = p_sequence;
  elsif p_sender is not null then select workspace_id into ws from outreach_senders where id = p_sender;
  else raise exception 'E_PAYLOAD_INVALID: sequence, sender or enrollment required'; end if;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'client_viewer');

  for f in select key, value from outreach_flags where key in ('tick_enabled','planner_enabled') and value in ('false'::jsonb, '"false"'::jsonb) loop
    causes := causes || jsonb_build_object('code','E_PLATFORM_PAUSED','blocking',true,'detail','Automation is paused platform-wide by the operators (' || f.key || ')','remedy','Nothing to do in the workspace.');
  end loop;

  if p_sequence is not null then
    select * into q from outreach_sequences where id = p_sequence;
    if not outreach_client_visible(ws, q.client_id) then raise exception 'E_FORBIDDEN'; end if;
    target := 'Sequence "' || q.name || '"';
    if q.status <> 'active' then causes := causes || jsonb_build_object('code','E_SEQUENCE_NOT_ACTIVE','blocking',true,'detail','The sequence is ' || q.status::text,'remedy','Activate it.'); end if;
    if coalesce(array_length(q.sender_pool,1),0) = 0 then causes := causes || jsonb_build_object('code','E_POOL_EMPTY','blocking',true,'detail','The sequence has no senders','remedy','Add a connected sender to the pool.'); end if;
    select array_agg(distinct outreach_node_action_type(x.value->>'type')::text) into need from jsonb_each(q.graph->'nodes') x where outreach_node_action_type(x.value->>'type') is not null;
    if need is not null and exists (select 1 from jsonb_each(q.graph->'nodes') x where x.value->>'type' in ('send_message','send_voice_note')) then need := need || 'new_chat'::text; end if;
  end if;

  if p_enrollment is not null then
    select * into l from outreach_leads where id = e.lead_id;
    target := coalesce(l.full_name,'Lead') || ' in "' || q.name || '"';
    n := outreach_enrollment_graph(e.id)->'nodes'->e.current_node_id;
    need := array_remove(array[outreach_node_action_type(n->>'type')::text], null);
    select sn_.provider into eprov from outreach_senders sn_ where sn_.id = e.sender_id;
    if e.status not in ('active','waiting_connection','waiting_delay','waiting_task') then
      causes := causes || jsonb_build_object('code','E_ENROLLMENT_NOT_LIVE','blocking',true,'detail', case when e.held_at is not null then 'The lead replied and is held for review' else 'The lead is ' || replace(e.status::text,'_',' ') || coalesce(' (' || outreach_reason_text(e.exit_reason) || ')','') end,
        'remedy', case when e.held_at is not null then 'Resume or exit the lead from the task list.' when e.status = 'paused' then 'Resume the lead.' when e.status = 'failed' then 'Retry or skip the step from the failed-leads list.' else 'It is finished; enrol the lead again if appropriate.' end);
    end if;
    if outreach_enrollment_suppression_reason(e.id) is not null then causes := causes || jsonb_build_object('code','E_LEAD_SUPPRESSED','blocking',true,'detail','The lead is blacklisted (' || replace(outreach_enrollment_suppression_reason(e.id),'_',' ') || ')','remedy','Nothing will be sent. Do not work around a blacklist.'); end if;
    -- channel identity and consent
    ident := outreach_lead_identity(e.lead_id, eprov);
    if ident is null then
      causes := causes || jsonb_build_object('code','E_NO_IDENTITY','blocking',true,'detail', format('%s has no %s %s on file', coalesce(l.full_name,'The lead'), outreach__provider_label(eprov), case eprov when 'WHATSAPP' then 'number' when 'INSTAGRAM' then 'handle' else 'profile' end),
        'remedy','Add it on the lead page and mark it verified.');
    elsif (ident->>'is_valid')::boolean = false then
      causes := causes || jsonb_build_object('code','E_IDENTIFIER_INVALID','blocking',true,'detail', format('The number on file for %s is not on WhatsApp', coalesce(l.full_name,'the lead')),'remedy','Correct the number on the lead page.');
    end if;
    select * into caps from outreach_channel_capabilities where provider = eprov;
    if coalesce((caps.consent->>'required_for_first_contact')::boolean, false) and (n->>'type') in ('send_message','send_voice_note')
       and coalesce((n->'config'->>'new_chat_allowed')::boolean, true) and not outreach_lead_has_consent(e.lead_id, eprov)
       and not exists (select 1 from outreach_chats c where c.lead_id = e.lead_id and c.sender_id = e.sender_id)
       and not exists (select 1 from outreach_lead_sender_state x where x.lead_id = e.lead_id and x.sender_id = e.sender_id and x.unipile_chat_id is not null) then
      causes := causes || jsonb_build_object('code','E_NO_CONSENT','blocking',true,'detail', format('No recorded %s consent for %s, so no new chat is started', outreach__provider_label(eprov), coalesce(l.full_name,'the lead')),
        'remedy','Record the basis on the lead page (inbound message, form opt-in, existing customer, shared number). Do not attest what you cannot show.');
    end if;
    if e.status = 'waiting_delay' then
      if (n->>'type') = 'wait_for_reply' then causes := causes || jsonb_build_object('code','W_WAITING_REPLY','blocking',false,'next_capacity',e.wait_until,'detail','Waiting for a reply until ' || to_char(e.wait_until,'Mon DD HH24:MI'),'remedy','By design; it continues on its own.');
      else causes := causes || jsonb_build_object('code','W_WAITING_DELAY','blocking',false,'next_capacity',e.wait_until,'detail','Waiting in a delay until ' || to_char(e.wait_until,'Mon DD HH24:MI'),'remedy','By design; it continues on its own.'); end if;
    end if;
    if e.status = 'waiting_connection' then
      select relation::text into rel from outreach_lead_sender_state where lead_id = e.lead_id and sender_id = e.sender_id;
      if (n->>'type') = 'wait_follow_back' then
        causes := causes || jsonb_build_object('code','W_WAITING_FOLLOW_BACK','blocking',false,'next_capacity',e.wait_until,'detail','Waiting for the lead to follow back; the window ends ' || to_char(e.wait_until,'Mon DD'),'remedy','By design. The followers list is checked a few times a day.');
      else
        causes := causes || jsonb_build_object('code','W_WAITING_CONNECTION','blocking',false,'next_capacity',e.wait_until,'detail','Waiting for the invitation to be accepted (' || coalesce(rel,'pending') || '); the window ends ' || to_char(e.wait_until,'Mon DD'),'remedy','By design.');
      end if;
    end if;
    if e.status = 'waiting_task' then
      if e.wait_reason = 'enrichment' then causes := causes || jsonb_build_object('code','W_WAITING_ENRICHMENT','blocking',false,'detail','Waiting for the profile to be enriched before the first step','remedy','Happens within the sender''s profile-view allowance; starts anyway after 72 hours.');
      elsif e.wait_reason = 'ai_review' then causes := causes || jsonb_build_object('code','W_WAITING_AI_REVIEW','blocking',true,'detail','Waiting for someone to approve the AI-written line for this lead','remedy','Open AI review and approve, edit or skip it.');
      elsif e.wait_reason = 'ai_route' then causes := causes || jsonb_build_object('code','W_WAITING_AI_ROUTE','blocking',false,'detail','Waiting for the AI routing decision','remedy','Decided within minutes; falls back to "everything else" after 6 hours.');
      else
        select id, kind, title into tk from outreach_tasks where enrollment_id = e.id and completed_at is null order by created_at desc limit 1;
        causes := causes || jsonb_build_object('code','W_WAITING_TASK','blocking',true,'detail','Waiting for a teammate: ' || coalesce(tk.title, 'open task'),'remedy','Complete the task.','task_id',tk.id);
      end if;
    end if;
    if e.status = 'active' then
      select action_type::text t, scheduled_for, decision into nx from outreach_actions where enrollment_id = e.id and status in ('queued','reserved') order by scheduled_for limit 1;
      if found then causes := causes || jsonb_build_object('code','W_SCHEDULED','blocking',false,'next_capacity',nx.scheduled_for,'detail','The next step (' || outreach_action_label(nx.t) || ') is planned for ' || to_char(nx.scheduled_for,'Mon DD HH24:MI') || case when nx.decision = 'budget_deferred' then ' (moved: today''s allowance was used)' when nx.decision = 'hourly_deferred' then ' (moved: this hour''s allowance was used)' else '' end,'remedy','Nothing to fix.');
      else causes := causes || jsonb_build_object('code','W_NOT_PLANNED_YET','blocking',false,'detail','Active with no planned action yet','remedy','The planner assigns a slot within 20 minutes when the sender has allowance.'); end if;
    end if;
    causes := causes || outreach__sender_causes(e.sender_id, coalesce(need, outreach__default_need(eprov)));
  elsif p_sequence is not null then
    select count(*) filter (where x.status in ('active','waiting_connection','waiting_delay','waiting_task')),
           count(*) filter (where x.status = 'waiting_task' and x.wait_reason = 'ai_review') into live, waiting
      from outreach_enrollments x where x.sequence_id = p_sequence;
    select count(*) into queued from outreach_actions a join outreach_enrollments x on x.id = a.enrollment_id where x.sequence_id = p_sequence and a.status = 'queued';
    notes := notes || to_jsonb(format('%s live lead(s), %s planned action(s)', live, queued));
    if live = 0 then causes := causes || jsonb_build_object('code','E_NO_LEADS','blocking',true,'detail','No leads are in this sequence','remedy','Enrol leads, or add an auto-enrol rule.'); end if;
    if waiting > 0 then causes := causes || jsonb_build_object('code','W_WAITING_AI_REVIEW','blocking', waiting = live,'detail', format('%s lead(s) wait for their AI-written line to be approved', waiting),'remedy','Open AI review.'); end if;
    foreach sid in array coalesce(q.sender_pool, '{}') loop
      sc := outreach__sender_causes(sid, coalesce(need, outreach__default_need((select sn_.provider from outreach_senders sn_ where sn_.id = sid))));
      if not exists (select 1 from jsonb_array_elements(sc) x where (x->>'blocking')::boolean) then ok_senders := ok_senders + 1; end if;
      causes := causes || sc;
    end loop;
    if ok_senders > 0 then
      select coalesce(jsonb_agg(case when x ? 'sender_id' and (x->>'blocking')::boolean then x || jsonb_build_object('blocking', false, 'partial', true) else x end), '[]'::jsonb) into causes from jsonb_array_elements(causes) x;
    end if;
    if q.throttled_reason is not null then causes := causes || jsonb_build_object('code','W_THROTTLED','blocking',false,'detail',q.throttled_reason,'remedy','The pool cannot keep up with demand: add senders or accept the longer projection.'); end if;
  else
    select * into s from outreach_senders where id = p_sender;
    if not outreach_client_visible(ws, s.client_id) then raise exception 'E_FORBIDDEN'; end if;
    target := 'Sender "' || coalesce(s.display_name,'') || '"';
    causes := causes || outreach__sender_causes(p_sender, case when s.provider = 'LINKEDIN' then array['invite','message','profile_view','inmail','email','new_chat'] else outreach__default_need(s.provider) end);
    select count(*) into live from outreach_enrollments x where x.sender_id = p_sender and x.status in ('active','waiting_connection','waiting_delay','waiting_task');
    select count(*) into queued from outreach_actions a where a.sender_id = p_sender and a.status = 'queued';
    notes := notes || to_jsonb(format('%s live lead(s), %s planned action(s)', live, queued));
    if live = 0 then causes := causes || jsonb_build_object('code','W_NO_DEMAND','blocking',false,'detail','No leads are assigned to this sender','remedy','Add it to a sequence and enrol leads.'); end if;
  end if;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into blocking from jsonb_array_elements(causes) x where (x->>'blocking')::boolean;
  first_text := coalesce(blocking->0->>'detail', causes->0->>'detail');
  return jsonb_build_object('target', target, 'blocked', jsonb_array_length(blocking) > 0,
    'reason', case when jsonb_array_length(blocking) > 0 then first_text when jsonb_array_length(causes) > 0 then 'Nothing is blocking. ' || first_text else 'Nothing is blocking.' end,
    'causes', causes, 'notes', notes, 'rule', 'Never respond to a cap, schedule or health block by raising volume elsewhere.');
end $$;

-- -----------------------------------------------------------------------------
-- Senders: quiet period (PRD §7.3), account-age attestation, provider warning (PRD §7.5), blocks, governor (PRD §7.4)
-- -----------------------------------------------------------------------------
-- status → ok from connecting / credentials / error: WhatsApp waits 24 h before outreach (replies still go out)
create or replace function outreach_trg_sender_quiet_period() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare hrs int;
begin
  if new.status = 'ok' and old.status in ('connecting','credentials','error') then
    select coalesce((c.ledger->>'post_connect_quiet_hours')::int, 0) into hrs from outreach_channel_capabilities c where c.provider = new.provider;
    if coalesce(hrs, 0) > 0 then
      new.outreach_allowed_from := now() + make_interval(hours => hrs);
      insert into outreach_sender_events(sender_id, kind, data) values (new.id, 'quiet_period', jsonb_build_object('until', new.outreach_allowed_from, 'hours', hrs, 'from_status', old.status));
    else
      new.outreach_allowed_from := null;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists outreach_sender_quiet_period on outreach_senders;
create trigger outreach_sender_quiet_period before update of status on outreach_senders for each row execute function outreach_trg_sender_quiet_period();

-- WhatsApp numbers need at least 6 months of real use before outreach (PRD §4.2, §7.4); a manager attests it
create or replace function outreach_sender_attest_account_age(p_sender uuid, p_months int) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare sn outreach_senders%rowtype;
begin
  select * into sn from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(sn.workspace_id, 'manager');
  if not outreach_client_visible(sn.workspace_id, sn.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if sn.provider <> 'WHATSAPP' then raise exception 'E_PAYLOAD_INVALID: account age is attested for WhatsApp numbers only'; end if;
  if coalesce(p_months, 0) < 6 then raise exception 'E_ACCOUNT_TOO_NEW: WhatsApp numbers need at least 6 months of real use before outreach'; end if;
  update outreach_senders set account_age_months = p_months, account_age_attested_at = now(), account_age_attested_by = auth.uid() where id = p_sender;
  perform outreach_audit(sn.workspace_id, 'sender.account_age_attested', 'sender', p_sender::text, jsonb_build_object('months', p_months));
end $$;

-- "We suspect automated behavior" and the like: one level down, 48 h pause, the text kept verbatim for the operator
create or replace function outreach_sender_provider_warning(p_sender uuid, p_text text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare sn outreach_senders%rowtype; lvl int; until_at timestamptz := now() + interval '48 hours';
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into sn from outreach_senders where id = p_sender;
  if not found then return; end if;
  lvl := greatest(sn.warmup_level - 1, 0);
  update outreach_senders set warmup_level = lvl, paused_until = until_at, status_reason = 'provider_warning',
         provider_warning = jsonb_build_object('text', left(coalesce(p_text, ''), 1000), 'at', now(), 'level_before', sn.warmup_level, 'paused_until', until_at)
   where id = p_sender;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'provider_warning', jsonb_build_object('text', left(coalesce(p_text, ''), 1000), 'level_before', sn.warmup_level, 'paused_until', until_at));
  perform outreach_emit_event(sn.workspace_id, 'sender.provider_warning', jsonb_build_object('id', p_sender, 'text', left(coalesce(p_text, ''), 1000), 'paused_until', until_at));
end $$;

create or replace function outreach_sender_resume_after_warning(p_sender uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare sn outreach_senders%rowtype;
begin
  select * into sn from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(sn.workspace_id, 'manager');
  if not outreach_client_visible(sn.workspace_id, sn.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  update outreach_senders set paused_until = null, provider_warning = null, status_reason = case when status_reason = 'provider_warning' then null else status_reason end where id = p_sender;
  perform outreach_audit(sn.workspace_id, 'sender.resume_after_warning', 'sender', p_sender::text, jsonb_build_object('warning', sn.provider_warning));
end $$;

-- A detected block: event with the five preceding sent actions, the relation, and (WhatsApp) an immediate one-level demotion
create or replace function outreach_record_block(p_sender uuid, p_lead uuid, p_code text, p_action uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare sn outreach_senders%rowtype; a outreach_actions%rowtype; prec jsonb; lvl int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into sn from outreach_senders where id = p_sender;
  if not found then return; end if;
  if p_action is not null then select * into a from outreach_actions where id = p_action; end if;
  select coalesce(jsonb_agg(jsonb_build_object('at', x.executed_at, 'type', x.action_type, 'lead_id', x.lead_id) order by x.executed_at desc), '[]'::jsonb) into prec
    from (select executed_at, action_type, lead_id from outreach_actions
           where sender_id = p_sender and status = 'sent' and action_type <> 'reply' and executed_at is not null and (p_action is null or id <> p_action)
           order by executed_at desc limit 5) x;
  insert into outreach_sender_events(sender_id, kind, data)
  values (p_sender, 'block', jsonb_build_object('lead_id', p_lead, 'code', p_code, 'action_id', p_action, 'action_type', a.action_type, 'preceding', prec));
  if p_lead is not null then
    insert into outreach_lead_sender_state(lead_id, sender_id, relation) values (p_lead, p_sender, 'blocked')
    on conflict (lead_id, sender_id) do update set relation = 'blocked', updated_at = now();
  end if;
  if sn.provider = 'WHATSAPP' and sn.warmup_level > 0 then
    lvl := sn.warmup_level - 1;
    update outreach_senders set warmup_level = lvl, warmup_locked_until = greatest(coalesce(warmup_locked_until, current_date), current_date + 7) where id = p_sender;
    insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'warmup', jsonb_build_object('reason', 'block', 'from', sn.warmup_level, 'to', lvl, 'by', 'record_block'));
  end if;
  perform outreach_emit_event(sn.workspace_id, 'sender.blocked', jsonb_build_object('id', p_sender, 'lead_id', p_lead, 'code', p_code, 'action_id', p_action));
end $$;

-- Health inputs (002 keys unchanged) + the channel keys the health worker and the governor read
create or replace function outreach_health_inputs(p_sender uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; res jsonb; daily int[]; d date; i int; idle_before int := 0; today_actions int;
begin
  select * into s from outreach_senders where id = p_sender;
  d := outreach_sender_local_date(p_sender, now());
  daily := '{}';
  for i in reverse 14..1 loop
    daily := daily || coalesce((select count(*)::int from outreach_actions a where a.sender_id = p_sender and a.status = 'sent' and a.action_type not in ('reply','relations_poll')
                                  and outreach_sender_local_date(p_sender, a.executed_at) = d - i), 0);
  end loop;
  select count(*)::int into today_actions from outreach_actions a where a.sender_id = p_sender and a.status = 'sent' and a.action_type not in ('reply','relations_poll') and outreach_sender_local_date(p_sender, a.executed_at) = d;
  for i in reverse 14..1 loop
    if daily[i] = 0 then idle_before := idle_before + 1; else exit; end if;
  end loop;
  res := jsonb_build_object(
    'currently_ok', s.status = 'ok',
    'disconnects_14d', (select count(*) from outreach_sender_events e where e.sender_id = p_sender and e.kind = 'status' and e.data->>'to' in ('credentials','error') and e.at > now() - interval '14 days'),
    'checkpoints_30d', (select count(*) from outreach_sender_events e where e.sender_id = p_sender and e.kind = 'checkpoint' and e.at > now() - interval '30 days'),
    'rejects_14d', (select count(*) from outreach_sender_events e where e.sender_id = p_sender and e.kind = 'reject' and e.at > now() - interval '14 days'),
    'actions_14d', (select count(*) from outreach_actions a where a.sender_id = p_sender and a.status in ('sent','failed') and a.action_type not in ('reply','relations_poll') and a.executed_at > now() - interval '14 days'),
    'invites_14d', (select count(*) from outreach_lead_sender_state x where x.sender_id = p_sender and x.invite_sent_at > now() - interval '14 days'),
    'accepted_14d', (select count(*) from outreach_lead_sender_state x where x.sender_id = p_sender and x.invite_sent_at > now() - interval '14 days' and x.invite_accepted_at is not null),
    'messages_14d', (select count(*) from outreach_actions a where a.sender_id = p_sender and a.status = 'sent' and a.action_type in ('message','inmail') and a.executed_at > now() - interval '14 days'),
    'replies_14d', (select count(distinct x.lead_id) from outreach_lead_sender_state x where x.sender_id = p_sender and x.last_inbound_at > now() - interval '14 days' and x.last_outbound_at is not null),
    'daily_actions_14d', to_jsonb(daily),
    'today_actions', today_actions,
    'idle_days_before_today', idle_before,
    'health_score', s.health_score,
    'health_high_since', s.health_high_since,
    'warmup_level', s.warmup_level,
    'warmup_locked_until', s.warmup_locked_until,
    'is_premium', s.is_premium,
    -- channels (025/026)
    'provider', s.provider,
    'blocks_30d', (select count(*) from outreach_sender_events e where e.sender_id = p_sender and e.kind = 'block' and e.at > now() - interval '30 days'),
    'new_chats_14d', (select count(*) from outreach_actions a where a.sender_id = p_sender and a.status = 'sent' and a.action_type = 'new_chat' and a.executed_at > now() - interval '14 days'),
    'new_chats_replied_14d', (select count(*) from outreach_actions a where a.sender_id = p_sender and a.status = 'sent' and a.action_type = 'new_chat' and a.executed_at > now() - interval '14 days'
                                and exists (select 1 from outreach_lead_sender_state x where x.lead_id = a.lead_id and x.sender_id = p_sender and x.last_inbound_at > a.executed_at)),
    'new_chats_all', (select count(*) from outreach_actions a where a.sender_id = p_sender and a.status = 'sent' and a.action_type = 'new_chat'),
    'new_chats_replied_all', (select count(*) from outreach_actions a where a.sender_id = p_sender and a.status = 'sent' and a.action_type = 'new_chat'
                                and exists (select 1 from outreach_lead_sender_state x where x.lead_id = a.lead_id and x.sender_id = p_sender and x.last_inbound_at > a.executed_at)),
    'days_connected', case when s.connected_at is null then null else floor(extract(epoch from now() - s.connected_at) / 86400)::int end,
    'inbound_conversations', (select count(distinct c.id) from outreach_chats c join outreach_messages m on m.chat_id = c.id where c.sender_id = p_sender and m.direction = 'in'),
    'account_age_attested', s.account_age_attested_at is not null and coalesce(s.account_age_months, 0) >= 6,
    'account_age_months', s.account_age_months,
    'disconnect_within_24h_of_outreach', exists (select 1 from outreach_sender_events e
        where e.sender_id = p_sender and e.kind = 'status' and e.data->>'to' in ('credentials','error') and e.at > now() - interval '14 days'
          and exists (select 1 from outreach_actions a where a.sender_id = p_sender and a.status = 'sent' and outreach__is_outbound_type(a.action_type) and a.executed_at between e.at - interval '24 hours' and e.at)),
    'provider_warning', s.provider_warning is not null and s.paused_until is not null and s.paused_until > now(),
    'outreach_allowed_from', s.outreach_allowed_from
  );
  return res;
end $$;

-- WhatsApp new-chat governor (PRD §7.4). One level per call. Demotion any time (14-day reply rate < 25% over ≥10 new
-- chats, or a disconnect within 24 h of outreach; blocks demote immediately in outreach_record_block), with a 7-day
-- cool-down; promotion only when nothing demoted, health ≥ 70, no block in 30 days and the level's condition holds.
create or replace function outreach_wa_governor(p_sender uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; inp jsonb; lvl int; new_lvl int; reason text; rate numeric; nc int; ncr int; recent_demotion boolean; locked boolean;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if s.provider <> 'WHATSAPP' then return jsonb_build_object('level_before', s.warmup_level, 'level_after', s.warmup_level, 'reason', 'not_whatsapp'); end if;
  inp := outreach_health_inputs(p_sender);
  lvl := s.warmup_level; new_lvl := lvl;
  nc := (inp->>'new_chats_14d')::int; ncr := (inp->>'new_chats_replied_14d')::int;
  rate := case when nc > 0 then round(100.0 * ncr / nc, 1) end;
  recent_demotion := exists (select 1 from outreach_sender_events e where e.sender_id = p_sender and e.kind = 'warmup' and e.data->>'reason' in ('block','reply_rate','disconnect') and e.at > now() - interval '7 days');
  locked := s.warmup_locked_until is not null and s.warmup_locked_until > current_date;

  if not recent_demotion and lvl > 0 then
    if nc >= 10 and rate < 25 then new_lvl := lvl - 1; reason := 'reply_rate';
    elsif (inp->>'disconnect_within_24h_of_outreach')::boolean then new_lvl := lvl - 1; reason := 'disconnect'; end if;
  end if;

  if new_lvl = lvl then
    if locked then reason := format('Level %s is locked until %s after a demotion', lvl, s.warmup_locked_until);
    elsif s.health_score < 70 then reason := format('Health must be 70 or more to move up (now %s)', s.health_score);
    elsif (inp->>'blocks_30d')::int > 0 then reason := format('%s block(s) in the last 30 days: no promotion', inp->>'blocks_30d');
    elsif lvl = 0 then
      if (inp->>'days_connected')::int >= 7 and (inp->>'inbound_conversations')::int >= 5 and (inp->>'account_age_attested')::boolean then new_lvl := 1; reason := 'promoted';
      else reason := format('Level 1 needs 7 days connected (now %s), 5 inbound conversations (now %s) and an account-age attestation of 6+ months (%s)',
                            coalesce(inp->>'days_connected','0'), inp->>'inbound_conversations', case when (inp->>'account_age_attested')::boolean then 'done' else 'not attested' end); end if;
    elsif lvl = 1 then
      if nc >= 10 and rate >= 40 then new_lvl := 2; reason := 'promoted'; else reason := format('Level 2 needs a 14-day reply rate of 40%% over 10+ new chats (now %s%% over %s)', coalesce(rate::text,'–'), nc); end if;
    elsif lvl = 2 then
      if nc >= 25 and rate >= 40 then new_lvl := 3; reason := 'promoted'; else reason := format('Level 3 needs a 14-day reply rate of 40%% over 25+ new chats (now %s%% over %s)', coalesce(rate::text,'–'), nc); end if;
    elsif lvl = 3 then
      if nc >= 50 and rate >= 45 then new_lvl := 4; reason := 'promoted'; else reason := format('Level 4 needs a 14-day reply rate of 45%% over 50+ new chats (now %s%% over %s)', coalesce(rate::text,'–'), nc); end if;
    else
      reason := 'max_level';
    end if;
  end if;

  if new_lvl <> lvl then
    update outreach_senders set warmup_level = new_lvl,
           warmup_locked_until = case when new_lvl < lvl then greatest(coalesce(warmup_locked_until, current_date), current_date + 7) else warmup_locked_until end
     where id = p_sender;
    insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'warmup', jsonb_build_object('reason', reason, 'from', lvl, 'to', new_lvl, 'by', 'wa_governor', 'reply_rate_14d', rate, 'new_chats_14d', nc));
  end if;
  return jsonb_build_object('level_before', lvl, 'level_after', new_lvl, 'reason', reason,
    'inputs', jsonb_build_object('new_chats_14d', nc, 'new_chats_replied_14d', ncr, 'reply_rate_14d', rate, 'blocks_30d', inp->'blocks_30d', 'days_connected', inp->'days_connected',
                                 'inbound_conversations', inp->'inbound_conversations', 'account_age_attested', inp->'account_age_attested'));
end $$;

-- -----------------------------------------------------------------------------
-- Other readers of ceilings / warm-up: the sender's provider decides (002 / 006 / 013 versions with the provider filter)
-- -----------------------------------------------------------------------------
create or replace function outreach_set_manual_caps(p_sender uuid, p_caps jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; k text; v int; c int; clean jsonb := '{}';
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  for k in select key from jsonb_each(p_caps) loop
    v := (p_caps->>k)::int;
    if k = 'all_metered' then
      select per_day into c from outreach_channel_totals where provider = s.provider and level = 5;
    else
      select per_day into c from outreach_platform_ceilings where provider = outreach__ceiling_provider(s.provider) and action_type = k::outreach_action_type_t;
    end if;
    if c is null then raise exception 'E_PAYLOAD_INVALID: unknown action type %', k; end if;
    if v > c then raise exception 'E_CAP_ABOVE_CEILING: % max is %', k, c; end if;
    if v >= 0 then clean := clean || jsonb_build_object(k, v); end if;
  end loop;
  update outreach_senders set manual_caps = clean where id = p_sender;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'caps', clean);
  perform outreach_audit(s.workspace_id, 'sender.caps', 'sender', p_sender::text, clean);
end $$;

create or replace function outreach_project_sequence(p_sequence uuid, p_lead_count int)
returns table(estimated_days int, bottleneck outreach_action_type_t, details jsonb)
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; n jsonb; t outreach_action_type_t; counts jsonb := '{}'; k text; per_lead int;
        cap_sum numeric; days_per_week numeric; need numeric; d numeric; worst numeric := 0; worst_t outreach_action_type_t; wait_days int := 0; sid uuid; wk numeric;
        det jsonb := '{}';
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then return; end if;
  if not outreach_is_service() then perform outreach_require(s.workspace_id, 'client_viewer'); end if;
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  for n in select value from jsonb_each(s.graph->'nodes') loop
    if outreach_is_executable_node(n->>'type') then
      t := outreach_node_action_type(n->>'type');
      counts := jsonb_set(counts, array[t::text], to_jsonb(coalesce((counts->>t::text)::int,0) + 1));
      if (n->>'type') in ('send_invite','send_message') then
        counts := jsonb_set(counts, array['profile_view'], to_jsonb(coalesce((counts->>'profile_view')::int,0) + 1));
      end if;
    elsif (n->>'type') in ('wait_connection','wait_follow_back') then
      wait_days := greatest(wait_days, coalesce((n->'config'->>'window_days')::int, case when (n->>'type') = 'wait_follow_back' then 5 else 14 end) / 2);
    elsif (n->>'type') = 'wait_for_reply' then
      wait_days := wait_days + ceil(coalesce((n->'config'->>'window_hours')::int, 96) / 24.0)::int / 2;
    elsif (n->>'type') = 'delay' and coalesce(n->'config'->>'unit','days') = 'days' then
      wait_days := wait_days + coalesce((n->'config'->>'amount')::int, 0);
    end if;
  end loop;
  for k in select key from jsonb_each(counts) loop
    t := k::outreach_action_type_t;
    per_lead := (counts->>k)::int;
    cap_sum := 0;
    for sid in select unnest(s.sender_pool) loop
      select count(*) into days_per_week from (
        select key from jsonb_each(coalesce((select schedule from outreach_senders where id = sid),'{}'::jsonb)) x where jsonb_array_length(x.value) > 0
      ) q;
      cap_sum := cap_sum + outreach_effective_cap(sid, t) * (days_per_week / 7.0);
      if t = 'invite' then
        select least(cap_sum, (coalesce(per_week,150) / 7.0) * coalesce(array_length(s.sender_pool,1),1)) into wk from outreach_platform_ceilings where provider = 'LINKEDIN' and action_type = 'invite';
        cap_sum := least(cap_sum, wk);
      end if;
    end loop;
    need := per_lead * p_lead_count;
    d := case when cap_sum <= 0 then 9999 else ceil(need / cap_sum) end;
    det := det || jsonb_build_object(k, jsonb_build_object('total', need, 'per_day', round(cap_sum,1), 'days', d));
    if d > worst then worst := d; worst_t := t; end if;
  end loop;
  estimated_days := least(worst + wait_days, 9999)::int;
  bottleneck := worst_t;
  details := det || jsonb_build_object('wait_days', wait_days, 'pool_size', coalesce(array_length(s.sender_pool,1),0));
  return next;
end $$;

create or replace function outreach_sender_insights(p_sender uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; z text; today date; recs jsonb := '[]'; hb jsonb; inp jsonb; cur jsonb; prev jsonb; chart jsonb; headroom numeric; cap_sum numeric; used_sum numeric;
        ar numeric; next_on date; max_level int; growth int; snap_now int; snap_then int; guard int; cp outreach_provider_t;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'client_viewer');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN'; end if;
  z := outreach_ws_tz(s.workspace_id); today := (now() at time zone z)::date; cp := outreach__ceiling_provider(s.provider);
  hb := coalesce(s.health_breakdown, '{}'::jsonb);
  inp := outreach_health_inputs(p_sender);
  select totals into cur from outreach__grouped(s.workspace_id, null, today - 29, today, 'none', jsonb_build_object('sender_id', p_sender));
  select totals into prev from outreach__grouped(s.workspace_id, null, today - 59, today - 30, 'none', jsonb_build_object('sender_id', p_sender));
  cur := coalesce(cur, outreach__totals_from('{}'::jsonb)); prev := coalesce(prev, outreach__totals_from('{}'::jsonb));

  select coalesce(sum(cap),0), coalesce(sum(used),0) into cap_sum, used_sum from outreach_sender_budgets where sender_id = p_sender and action_type = 'invite' and day >= current_date - 30 and cap > 0;
  headroom := case when cap_sum > 0 then round(100.0 * (cap_sum - used_sum) / cap_sum, 1) end;
  select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'sent', coalesce(b.used,0), 'cap', b.cap) order by d.day), '[]'::jsonb) into chart
    from (select generate_series(current_date - 29, current_date, interval '1 day')::date as day) d
    left join outreach_sender_budgets b on b.sender_id = p_sender and b.action_type = 'invite' and b.day = d.day;
  select (data->>'connections_count')::int into snap_now from outreach_sender_events where sender_id = p_sender and kind = 'snapshot' order by at desc limit 1;
  select (data->>'connections_count')::int into snap_then from outreach_sender_events where sender_id = p_sender and kind = 'snapshot' and at <= now() - interval '29 days' order by at desc limit 1;
  growth := case when snap_now is not null and snap_then is not null then snap_now - snap_then else (cur->>'accepted')::int end;

  ar := case when (inp->>'invites_14d')::numeric >= 20 then round(100.0 * (inp->>'accepted_14d')::numeric / (inp->>'invites_14d')::numeric, 0) end;
  if s.status in ('credentials','error') then recs := recs || jsonb_build_object('severity','high','area','session','text','This sender is disconnected. Reconnect it before anything else: nothing is being sent.'); end if;
  if coalesce((hb->>'acceptance_rate')::numeric, 100) < 85 and ar is not null then
    recs := recs || jsonb_build_object('severity', case when ar < 15 then 'high' else 'medium' end, 'area','acceptance_rate',
      'text', format('Acceptance rate is %s%%. Below 20%% LinkedIn notices. Tighten targeting or rewrite the invitation note before raising volume.', ar));
  end if;
  if coalesce((hb->>'rejection_rate')::numeric, 100) < 80 then
    recs := recs || jsonb_build_object('severity','high','area','rejection_rate','text', format('The provider rejected %s of the last %s actions. Keep volume flat for a week; the caps already dropped to protect the account.', inp->>'rejects_14d', inp->>'actions_14d'));
  end if;
  if coalesce((hb->>'session_stability')::numeric, 100) < 75 then
    recs := recs || jsonb_build_object('severity','medium','area','session_stability','text', format('The session dropped %s time(s) in 14 days. Turn on automatic reconnect (extension) and avoid logging in from new devices or countries.', inp->>'disconnects_14d'));
  end if;
  if coalesce((hb->>'reply_rate')::numeric, 100) < 80 then
    recs := recs || jsonb_build_object('severity','medium','area','reply_rate','text','Few people answer this sender''s messages. Test a shorter first message (A/B) before adding follow-ups.');
  end if;
  if coalesce((hb->>'consistency')::numeric, 100) < 75 then
    recs := recs || jsonb_build_object('severity', case when (hb->>'consistency')::numeric <= 10 then 'high' else 'low' end, 'area','consistency','text','Activity is uneven from day to day. Keep leads flowing steadily: a burst after idle days looks automated.');
  end if;
  if coalesce((hb->>'verification')::numeric, 100) < 100 then
    recs := recs || jsonb_build_object('severity','medium','area','verification','text', format('The provider asked for verification %s time(s) in 30 days. Complete it promptly and keep volume low for two weeks.', inp->>'checkpoints_30d'));
  end if;
  if coalesce((hb->>'block_signals')::numeric, 100) < 100 then
    recs := recs || jsonb_build_object('severity','high','area','block_signals','text', format('%s block(s) detected in 30 days. Every block lowers the level; review who is being contacted and how the first message reads.', inp->>'blocks_30d'));
  end if;
  if coalesce((hb->>'new_chat_reply_rate')::numeric, 100) < 85 then
    recs := recs || jsonb_build_object('severity','medium','area','new_chat_reply_rate','text','Too few new WhatsApp chats get a reply. WhatsApp watches this. Message people who expect you, and open with a question.');
  end if;
  if (cur->>'limit_hits')::numeric > 0 then
    recs := recs || jsonb_build_object('severity','medium','area','limits','text', format('The provider''s own limit was hit %s time(s) in 30 days. The platform pauses that action until the limit resets; lower the manual cap to stay under it.', cur->>'limit_hits'));
  end if;
  if headroom is not null and headroom > 60 and s.running_dry_at is null and s.status = 'ok' then
    recs := recs || jsonb_build_object('severity','low','area','headroom','text', format('%s%% of the invitation allowance went unused. There is room for more leads on this sender.', round(headroom)));
  end if;
  if s.running_dry_at is not null then recs := recs || jsonb_build_object('severity','medium','area','leads','text','This sender has less than two days of new leads queued. Enrol more leads or add an auto-enrol rule.'); end if;
  if jsonb_array_length(recs) = 0 then recs := recs || jsonb_build_object('severity','ok','area','all','text','Nothing to fix. Keep volume steady and the next warm-up level unlocks on its own.'); end if;

  max_level := case when s.provider = 'WHATSAPP' then 4 when s.is_premium or s.provider <> 'LINKEDIN' then 5 else 1 end;
  next_on := case when s.provider = 'WHATSAPP' then null
                  when s.warmup_level >= max_level then null
                  when s.health_score < 85 then null
                  else greatest(coalesce(s.health_high_since, current_date) + 14, coalesce(s.warmup_locked_until + 1, current_date)) end;
  guard := outreach_inmail_guard(p_sender, current_date);

  return jsonb_build_object(
    'sender', jsonb_build_object('id', s.id, 'name', s.display_name, 'status', s.status, 'health', s.health_score, 'level', s.warmup_level, 'provider', s.provider),
    'health_breakdown', hb - 'computed_at' - 'trigger', 'recommendations', recs,
    'warmup', jsonb_build_object('level', s.warmup_level, 'max_level', max_level, 'locked_until', s.warmup_locked_until, 'health_high_since', s.health_high_since,
       'next_level_on', next_on,
       'unlocks', case when s.provider = 'WHATSAPP' then 'WhatsApp levels are set by the reply-rate governor each night: more replies on the chats you start move the number up; blocks and silence move it down.'
                       when s.warmup_level >= max_level then case when max_level = 1 then 'Free LinkedIn accounts stay at level 1. A Premium or Sales Navigator seat unlocks higher levels.' else 'Top level reached.' end
                       when s.health_score < 85 then format('Health must reach 85 (now %s) and stay there for 14 days.', s.health_score)
                       else format('Health has been 85+ since %s. Level %s unlocks on %s.', coalesce(s.health_high_since, current_date), s.warmup_level + 1, next_on) end,
       'caps_now', (select coalesce(jsonb_object_agg(action_type, per_day), '{}'::jsonb) from outreach_warmup_caps where provider = cp and level = s.warmup_level),
       'caps_next', (select coalesce(jsonb_object_agg(action_type, per_day), '{}'::jsonb) from outreach_warmup_caps where provider = cp and level = least(s.warmup_level + 1, max_level)),
       'total_now', (select per_day from outreach_channel_totals where provider = s.provider and level = s.warmup_level),
       'total_next', (select per_day from outreach_channel_totals where provider = s.provider and level = least(s.warmup_level + 1, max_level))),
    'last_30_days', jsonb_build_object('headroom_pct', headroom, 'limit_hits', cur->'limit_hits', 'acceptance_rate', cur->'acceptance_rate', 'acceptance_rate_previous', prev->'acceptance_rate',
       'network_growth', growth, 'network_growth_source', case when snap_now is not null and snap_then is not null then 'connections_count' else 'accepted_invitations' end,
       'invites', cur->'invites', 'accepted', cur->'accepted', 'replies', cur->'replies', 'reply_rate', cur->'reply_rate', 'new_chats', cur->'new_chats', 'blocks', cur->'blocks'),
    'invites_vs_cap', chart,
    'inmail_guard', jsonb_build_object('max_today', guard, 'rule', 'InMails may grow at most ~50% above last week''s daily average (never below 3 a day). LinkedIn has blocked senders who jumped from about 3 to 16 a day.'));
end $$;

-- -----------------------------------------------------------------------------
-- Reports (013): channel = the sender's / chat's provider; new metric `block`; new totals keys
-- -----------------------------------------------------------------------------
create or replace function outreach__action_facts_live(p_ws uuid, p_from date, p_to date)
returns table(day date, client_id uuid, sequence_id uuid, node_id text, variant_id text, sender_id uuid, channel text, metric text, n numeric)
language sql stable security definer set search_path = public, extensions as $$
  with tz as (select outreach_ws_tz(p_ws) z),
  a as (
    select (x.executed_at at time zone (select z from tz))::date as day, coalesce(q.client_id, s.client_id) as client_id, e.sequence_id, x.node_id, x.variant_id, x.sender_id,
           case when x.action_type = 'email' then 'email' else outreach__channel_of(s.provider) end as channel, x.action_type, x.status, x.payload, x.response
      from outreach_actions x
      join outreach_senders s on s.id = x.sender_id
      left join outreach_enrollments e on e.id = x.enrollment_id
      left join outreach_sequences q on q.id = e.sequence_id
     where x.workspace_id = p_ws and x.executed_at is not null
       and x.executed_at >= (p_from::timestamp at time zone (select z from tz)) and x.executed_at < ((p_to + 1)::timestamp at time zone (select z from tz))
       and x.status in ('sent','failed','skipped')
  )
  select day, client_id, sequence_id, node_id, variant_id, sender_id, channel,
         case when status <> 'sent' then status::text when action_type = 'reply' then 'manual_reply' else action_type::text end, count(*)::numeric
    from a where not (status <> 'sent' and (coalesce((payload->>'prefetch')::boolean,false) or coalesce((payload->>'subtask')::boolean,false)))
   group by 1,2,3,4,5,6,7,8
  union all
  select day, client_id, sequence_id, node_id, variant_id, sender_id, channel, 'invite_with_note', count(*)::numeric
    from a where status = 'sent' and action_type = 'invite' and coalesce((response->>'note_length')::int, 0) > 0
   group by 1,2,3,4,5,6,7
$$;
revoke execute on function outreach__action_facts_live(uuid,date,date) from public, anon, authenticated;

create or replace function outreach__facts(p_ws uuid, p_from date, p_to date)
returns table(day date, client_id uuid, sequence_id uuid, node_id text, variant_id text, sender_id uuid, channel text, metric text, n numeric)
language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); rt date; f_ts timestamptz; t_ts timestamptz; zero uuid := '00000000-0000-0000-0000-000000000000';
begin
  f_ts := p_from::timestamp at time zone z; t_ts := (p_to + 1)::timestamp at time zone z;
  select rolled_through into rt from outreach_rollup_state where workspace_id = p_ws;

  -- 1. action volume: rollup up to rolled_through, live after it
  if rt is not null and rt >= p_from then
    return query
      select d.day, nullif(d.client_id, zero), nullif(d.sequence_id, zero), nullif(d.node_id,''), nullif(d.variant_id,''), d.sender_id, d.channel, m.key, (m.value)::numeric
        from outreach_daily_stats d, jsonb_each_text(d.metrics) m
       where d.workspace_id = p_ws and d.day between p_from and least(p_to, rt);
  end if;
  if rt is null or rt < p_to then
    return query select * from outreach__action_facts_live(p_ws, greatest(p_from, coalesce(rt + 1, p_from)), p_to);
  end if;

  -- 2. accepted: dated by acceptance, attributed to the invite that was accepted
  return query
    select (x.invite_accepted_at at time zone z)::date, coalesce(q.client_id, s.client_id), e.sequence_id, ia.node_id, ia.variant_id, x.sender_id, 'linkedin'::text, 'accepted'::text, count(*)::numeric
      from outreach_lead_sender_state x
      join outreach_senders s on s.id = x.sender_id and s.workspace_id = p_ws
      left join lateral (select a.node_id, a.variant_id, a.enrollment_id from outreach_actions a
                          where a.lead_id = x.lead_id and a.sender_id = x.sender_id and a.action_type = 'invite' and a.status = 'sent' and a.executed_at <= x.invite_accepted_at
                          order by a.executed_at desc limit 1) ia on true
      left join outreach_enrollments e on e.id = ia.enrollment_id
      left join outreach_sequences q on q.id = e.sequence_id
     where x.invite_accepted_at >= f_ts and x.invite_accepted_at < t_ts and x.invite_sent_at is not null
     group by 1,2,3,4,5,6;

  -- 3. replies: a thread's FIRST reply to an automated step, dated by that reply, classified by the thread's current intent
  return query
    select (m.sent_at at time zone z)::date, coalesce(q.client_id, c.client_id), e.sequence_id, a.node_id, a.variant_id, c.sender_id,
           outreach__channel_of(c.provider), k.metric, count(*)::numeric
      from outreach_messages m
      join outreach_chats c on c.id = m.chat_id
      join outreach_actions a on a.id = m.replied_to_action_id
      left join outreach_enrollments e on e.id = a.enrollment_id
      left join outreach_sequences q on q.id = e.sequence_id
      cross join lateral (values ('reply'), ('reply_' || (case when c.intent <> 'unclassified' then c.intent else coalesce(m.intent, 'unclassified') end)::text)) k(metric)
     where m.workspace_id = p_ws and m.is_first_reply and m.sent_at >= f_ts and m.sent_at < t_ts
     group by 1,2,3,4,5,6,7,8;

  -- 4. every inbound message (conversation volume; not a rate numerator)
  return query
    select (m.sent_at at time zone z)::date, c.client_id, null::uuid, null::text, null::text, c.sender_id,
           outreach__channel_of(c.provider), 'inbound'::text, count(*)::numeric
      from outreach_messages m join outreach_chats c on c.id = m.chat_id
     where m.workspace_id = p_ws and m.direction = 'in' and m.sent_at >= f_ts and m.sent_at < t_ts
     group by 1,2,6,7;

  -- 5. enrolled (channel = the sender's provider)
  return query
    select (e.created_at at time zone z)::date, q.client_id, e.sequence_id, null::text, null::text, e.sender_id, outreach__channel_of(sx.provider), 'enrolled'::text, count(*)::numeric
      from outreach_enrollments e join outreach_sequences q on q.id = e.sequence_id left join outreach_senders sx on sx.id = e.sender_id
     where e.workspace_id = p_ws and e.created_at >= f_ts and e.created_at < t_ts
     group by 1,2,3,6,7;

  -- 6. milestones (meeting booked, won, lost) and won value
  return query
    select (ms.at at time zone z)::date, ms.client_id, ms.sequence_id, null::text, null::text, ms.sender_id, outreach__channel_of(sx.provider), k.metric, sum(k.v)::numeric
      from outreach_lead_milestones ms left join outreach_senders sx on sx.id = ms.sender_id
      cross join lateral (values (ms.kind, 1::numeric), (case when ms.kind = 'won' and ms.value is not null then 'won_value' end, ms.value)) k(metric, v)
     where ms.workspace_id = p_ws and ms.at >= f_ts and ms.at < t_ts and ms.kind in ('meeting','won','lost') and k.metric is not null
     group by 1,2,3,6,7,8;

  -- 7. email engagement (mail providers only)
  return query
    select (m.sent_at at time zone z)::date, c.client_id, e.sequence_id, a.node_id, a.variant_id, c.sender_id, 'email'::text, k.metric, count(*)::numeric
      from outreach_messages m join outreach_chats c on c.id = m.chat_id and c.provider in ('GMAIL','OUTLOOK','IMAP')
      left join outreach_actions a on a.id = m.action_id left join outreach_enrollments e on e.id = a.enrollment_id
      cross join lateral (values (case when m.opens > 0 then 'email_opened' end), (case when m.clicks > 0 then 'email_clicked' end)) k(metric)
     where m.workspace_id = p_ws and m.direction = 'out' and m.sent_at >= f_ts and m.sent_at < t_ts and k.metric is not null
     group by 1,2,3,4,5,6,8;
  return query
    select (x.updated_at at time zone z)::date, s.client_id, null::uuid, null::text, null::text, x.sender_id, 'email'::text, 'email_bounced'::text, count(*)::numeric
      from outreach_lead_sender_state x join outreach_senders s on s.id = x.sender_id and s.workspace_id = p_ws
     where x.email_bounced and x.updated_at >= f_ts and x.updated_at < t_ts group by 1,2,6;

  -- 8. provider limit hits
  return query
    select (ev.at at time zone z)::date, s.client_id, null::uuid, null::text, null::text, ev.sender_id, outreach__channel_of(s.provider), 'limit_hit'::text, count(*)::numeric
      from outreach_sender_events ev join outreach_senders s on s.id = ev.sender_id and s.workspace_id = p_ws
     where ev.kind = 'reject' and (ev.data->>'decision' = 'sender_cap_hit' or coalesce((ev.data->>'limit_hit')::boolean, false)) and ev.at >= f_ts and ev.at < t_ts
     group by 1,2,6,7;

  -- 9. blocks detected (PRD §7.7, §12)
  return query
    select (ev.at at time zone z)::date, s.client_id, null::uuid, null::text, null::text, ev.sender_id, outreach__channel_of(s.provider), 'block'::text, count(*)::numeric
      from outreach_sender_events ev join outreach_senders s on s.id = ev.sender_id and s.workspace_id = p_ws
     where ev.kind = 'block' and ev.at >= f_ts and ev.at < t_ts
     group by 1,2,6,7;
end $$;
revoke execute on function outreach__facts(uuid,date,date) from public, anon, authenticated;

create or replace function outreach__totals_from(p_m jsonb) returns jsonb
language sql immutable as $$
  with v as (select
    coalesce((p_m->>'invite')::numeric,0) invites, coalesce((p_m->>'invite_with_note')::numeric,0) notes, coalesce((p_m->>'accepted')::numeric,0) accepted,
    coalesce((p_m->>'message')::numeric,0) messages, coalesce((p_m->>'inmail')::numeric,0) inmails, coalesce((p_m->>'email')::numeric,0) emails,
    coalesce((p_m->>'new_chat')::numeric,0) new_chats,
    coalesce((p_m->>'reply')::numeric,0) replies, coalesce((p_m->>'reply_interested')::numeric,0) interested, coalesce((p_m->>'reply_not_interested')::numeric,0) not_interested,
    coalesce((p_m->>'reply_ooo')::numeric,0) ooo)
  select jsonb_build_object(
    'enrolled', coalesce((p_m->>'enrolled')::numeric,0),
    'invites', invites, 'invites_with_note', notes, 'accepted', accepted, 'acceptance_rate', outreach__rate(accepted, invites),
    'messages', messages, 'inmails', inmails, 'emails', emails, 'new_chats', new_chats, 'touches', messages + inmails + emails + notes + new_chats,
    'replies', replies, 'reply_rate', outreach__rate(replies, messages + inmails + emails + notes + new_chats),
    'interested', interested, 'interested_rate', outreach__rate(interested, messages + inmails + emails + notes + new_chats),
    'positive_reply_rate', outreach__rate(interested, replies - ooo), 'negative_reply_rate', outreach__rate(not_interested, replies - ooo),
    'intents', jsonb_build_object('interested', interested, 'question', coalesce((p_m->>'reply_question')::numeric,0), 'not_now', coalesce((p_m->>'reply_not_now')::numeric,0),
               'not_interested', not_interested, 'ooo', ooo, 'wrong_person', coalesce((p_m->>'reply_wrong_person')::numeric,0),
               'unclear', coalesce((p_m->>'reply_unclear')::numeric,0), 'unclassified', coalesce((p_m->>'reply_unclassified')::numeric,0)),
    'meetings', coalesce((p_m->>'meeting')::numeric,0), 'won', coalesce((p_m->>'won')::numeric,0), 'lost', coalesce((p_m->>'lost')::numeric,0), 'won_value', coalesce((p_m->>'won_value')::numeric,0),
    'inbound_messages', coalesce((p_m->>'inbound')::numeric,0), 'manual_replies', coalesce((p_m->>'manual_reply')::numeric,0),
    'profile_views', coalesce((p_m->>'profile_view')::numeric,0), 'likes', coalesce((p_m->>'like')::numeric,0), 'comments', coalesce((p_m->>'comment')::numeric,0),
    'endorsements', coalesce((p_m->>'endorse')::numeric,0), 'follows', coalesce((p_m->>'follow')::numeric,0), 'unfollows', coalesce((p_m->>'unfollow')::numeric,0), 'withdrawn', coalesce((p_m->>'withdraw')::numeric,0),
    'post_fetches', coalesce((p_m->>'post_fetch')::numeric,0), 'identifier_checks', coalesce((p_m->>'identifier_check')::numeric,0), 'followers_polls', coalesce((p_m->>'followers_poll')::numeric,0),
    'blocks', coalesce((p_m->>'block')::numeric,0),
    'failed', coalesce((p_m->>'failed')::numeric,0), 'skipped', coalesce((p_m->>'skipped')::numeric,0), 'limit_hits', coalesce((p_m->>'limit_hit')::numeric,0),
    'email_opened', coalesce((p_m->>'email_opened')::numeric,0), 'email_clicked', coalesce((p_m->>'email_clicked')::numeric,0), 'email_bounced', coalesce((p_m->>'email_bounced')::numeric,0),
    'open_rate', outreach__rate((p_m->>'email_opened')::numeric, emails), 'click_rate', outreach__rate((p_m->>'email_clicked')::numeric, emails), 'bounce_rate', outreach__rate((p_m->>'email_bounced')::numeric, emails))
  from v
$$;

create or replace function outreach_metric_definitions() returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'day', 'A calendar day in the workspace timezone (Settings → Workspace). Ranges include both end dates.',
    'invites', 'Connection requests LinkedIn accepted for delivery in the period.',
    'accepted', 'Invitations accepted in the period, whenever they were sent. Attributed to the step and variant that sent the invitation.',
    'acceptance_rate', 'Accepted ÷ invites sent, both in the period.',
    'touches', 'Messages + InMails + emails + new chats + invitations that carried a note. The denominator of every reply rate.',
    'new_chats', 'Conversations the platform started with someone it had no chat with yet, on any channel. WhatsApp and Instagram watch this number closely.',
    'replies', 'Threads in which the lead answered an automated step for the first time in the period. One lead answering three times is one reply. Replies to a teammate''s manual message are conversation, not replies.',
    'reply_rate', 'Replies ÷ touches.',
    'replies_per_100_actions', 'Replies ÷ every metered outbound action (invites, new chats, messages, InMails, emails, likes, comments, follows) × 100. Compares channels with very different volumes.',
    'interested', 'Replies whose thread is currently classified "interested" (AI classification, or your override).',
    'positive_reply_rate', 'Interested replies ÷ replies, leaving out-of-office auto-replies out of the denominator.',
    'negative_reply_rate', 'Not-interested replies ÷ replies, leaving out-of-office auto-replies out of the denominator.',
    'blocks', 'Times a person blocked the sender or a chat went one-way after our first message (detected by the executor and the block worker). Each one lowers the sender''s level.',
    'consent basis', 'Why we may message this person on WhatsApp: they wrote first (inbound), opted in on a form, are an existing customer, replied on LinkedIn, shared their number, or an operator attested consent at import (the weakest basis, shown in amber).',
    'meetings', 'Leads that reached a Meeting stage or booked through the booking link in the period. Counted once per lead.',
    'won', 'Leads that reached a Won stage in the period. Counted once per lead.',
    'cost_per_reply', 'Sender cost for the period ÷ replies. Sender cost = monthly cost × days in period ÷ 30 for every sender that was connected.',
    'funnel', 'Follows the leads ENROLLED in the period through every later stage, whenever that stage happened.',
    'headroom', 'Share of the invitation cap a sender did not use over the last 30 days.')
$$;

-- Channel efficiency (PRD §12): replies per 100 metered actions, per channel
create or replace function outreach_report_channels(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); f date; t date; vis uuid[] := outreach_visible_clients(p_ws); rows_ jsonb;
begin
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29);
  perform outreach__check_range(p_ws, p_client, f, t);
  with ch as (
    select outreach__channel_of(s.provider) as channel, count(*) as n
      from outreach_senders s
     where s.workspace_id = p_ws and s.deleted_at is null and (p_client is null or s.client_id = p_client) and (vis is null or s.client_id is null or s.client_id = any(vis))
     group by 1),
  g as (select grp, totals from outreach__grouped(p_ws, p_client, f, t, 'channel', '{}')),
  allc as (select channel from ch union select grp from g),
  rows0 as (
    select a.channel, coalesce(ch.n, 0) as senders, coalesce(g.totals, outreach__totals_from('{}'::jsonb)) as tt
      from allc a left join ch on ch.channel = a.channel left join g on g.grp = a.channel),
  rows1 as (
    select r.channel, r.senders, r.tt,
           (r.tt->>'invites')::numeric + (r.tt->>'new_chats')::numeric + (r.tt->>'messages')::numeric + (r.tt->>'inmails')::numeric + (r.tt->>'emails')::numeric
           + (r.tt->>'likes')::numeric + (r.tt->>'comments')::numeric + (r.tt->>'follows')::numeric as actions
      from rows0 r)
  select coalesce(jsonb_agg(jsonb_build_object('channel', r.channel, 'senders', r.senders, 'actions', r.actions, 'new_chats', r.tt->'new_chats', 'replies', r.tt->'replies',
           'replies_per_100_actions', outreach__rate((r.tt->>'replies')::numeric, r.actions), 'interested', r.tt->'interested', 'blocks', r.tt->'blocks', 'reply_rate', r.tt->'reply_rate')
           order by case r.channel when 'linkedin' then 1 when 'instagram' then 2 when 'whatsapp' then 3 else 4 end), '[]'::jsonb)
    into rows_ from rows1 r;
  return jsonb_build_object('period', jsonb_build_object('from', f, 'to', t, 'timezone', z), 'rows', rows_);
end $$;

-- Block and restriction log (PRD §12): every detected block with the actions that preceded it
create or replace function outreach_report_blocks(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null, p_sender uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); f date; t date; vis uuid[] := outreach_visible_clients(p_ws); rows_ jsonb; by_s jsonb;
begin
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29);
  perform outreach__check_range(p_ws, p_client, f, t);
  with ev as (
    select e.at, e.sender_id, s.display_name, s.provider, (e.data->>'lead_id')::uuid as lead_id, e.data->>'code' as code, e.data->'preceding' as preceding
      from outreach_sender_events e join outreach_senders s on s.id = e.sender_id
     where s.workspace_id = p_ws and e.kind = 'block' and e.at >= (f::timestamp at time zone z) and e.at < ((t + 1)::timestamp at time zone z)
       and (p_client is null or s.client_id = p_client) and (vis is null or s.client_id is null or s.client_id = any(vis))
       and (p_sender is null or e.sender_id = p_sender))
  select coalesce(jsonb_agg(jsonb_build_object('at', ev.at, 'sender_id', ev.sender_id, 'sender_name', ev.display_name, 'provider', ev.provider, 'lead_id', ev.lead_id,
           'lead_name', (select ld_.full_name from outreach_leads ld_ where ld_.id = ev.lead_id), 'code', ev.code, 'preceding', coalesce(ev.preceding, '[]'::jsonb)) order by ev.at desc), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('sender_id', x.sender_id, 'name', x.display_name, 'blocks', x.n) order by x.n desc)
                     from (select ev2.sender_id, ev2.display_name, count(*) as n from ev ev2 group by 1,2) x), '[]'::jsonb)
    into rows_, by_s from ev;
  return jsonb_build_object('period', jsonb_build_object('from', f, 'to', t, 'timezone', z), 'rows', rows_, 'by_sender', by_s);
end $$;

-- -----------------------------------------------------------------------------
-- Leads (015 + identities: `identities` array and the instagram_handle / whatsapp_phone shorthands)
-- -----------------------------------------------------------------------------
create or replace function outreach_upsert_lead(p_ws uuid, p_lead jsonb, p_source text default null, p_import_job uuid default null)
returns table(id uuid, created boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare pid citext; ew citext; ep citext; existing uuid; nid uuid; cid uuid; lid uuid; sid uuid; idents jsonb; it jsonb; res_id uuid; res_created boolean := false; iprov outreach_provider_t;
begin
  if not outreach_is_service() then perform outreach_require(p_ws, 'member'); end if;
  pid := nullif(lower(trim(coalesce(p_lead->>'public_identifier',''))),'')::citext;
  ew := nullif(lower(trim(coalesce(p_lead->>'email_work',''))),'')::citext;
  ep := nullif(lower(trim(coalesce(p_lead->>'email_personal',''))),'')::citext;
  cid := nullif(p_lead->>'client_id','')::uuid;
  lid := nullif(p_lead->>'list_id','')::uuid;
  sid := nullif(p_lead->>'stage_id','')::uuid;
  -- channel identities: validated before anything is written, so a bad phone never creates a half lead
  idents := case when jsonb_typeof(p_lead->'identities') = 'array' then p_lead->'identities' else '[]'::jsonb end;
  if nullif(p_lead->>'instagram_handle','') is not null then idents := idents || jsonb_build_array(jsonb_build_object('provider', 'INSTAGRAM', 'identifier', p_lead->>'instagram_handle')); end if;
  if nullif(p_lead->>'whatsapp_phone','') is not null then idents := idents || jsonb_build_array(jsonb_build_object('provider', 'WHATSAPP', 'identifier', p_lead->>'whatsapp_phone')); end if;
  for it in select * from jsonb_array_elements(idents) loop
    if upper(coalesce(it->>'provider','')) not in ('LINKEDIN','INSTAGRAM','WHATSAPP','GMAIL','OUTLOOK','IMAP') then raise exception 'E_PAYLOAD_INVALID: unknown identity provider %', it->>'provider'; end if;
    if upper(it->>'provider') = 'WHATSAPP' and outreach_normalize_phone(it->>'identifier') is null then raise exception 'E_PAYLOAD_INVALID: phone needs a country code, e.g. +91 98765 43210'; end if;
    if upper(it->>'provider') = 'INSTAGRAM' and outreach_normalize_handle(it->>'identifier') is null then raise exception 'E_PAYLOAD_INVALID: not an Instagram handle'; end if;
  end loop;

  if pid is not null then
    select l.id into existing from outreach_leads l where l.workspace_id = p_ws and l.public_identifier = pid;
  end if;
  if existing is null and (p_lead->>'provider_id') is not null then
    select l.id into existing from outreach_leads l where l.workspace_id = p_ws and l.provider_id = p_lead->>'provider_id';
  end if;
  if existing is null and ew is not null then
    select l.id into existing from outreach_leads l where l.workspace_id = p_ws and l.email_work = ew;
  end if;
  if existing is null and ep is not null then
    select l.id into existing from outreach_leads l where l.workspace_id = p_ws and l.email_personal = ep;
  end if;
  -- a lead known only by a handle or a number matches through its identity
  if existing is null then
    for it in select * from jsonb_array_elements(idents) loop
      iprov := upper(it->>'provider')::outreach_provider_t;
      select li.lead_id into existing from outreach_lead_identities li
       where li.workspace_id = p_ws and li.provider = iprov and li.identifier = outreach__identity_normalize(iprov, it->>'identifier')::citext;
      exit when existing is not null;
    end loop;
  end if;
  -- a client-scoped member (or API key) may not touch another client's lead, however it was matched
  if existing is not null and not outreach_is_service()
     and not outreach_client_visible(p_ws, (select l.client_id from outreach_leads l where l.id = existing)) then
    raise exception 'E_FORBIDDEN: this lead belongs to another client';
  end if;
  if existing is null and pid is null and ew is null and ep is null and (p_lead->>'provider_id') is null and jsonb_array_length(idents) = 0 then
    raise exception 'E_PAYLOAD_INVALID: lead needs public_identifier, email or a channel identity';
  end if;

  if existing is null and cid is not null and not outreach_is_service() and not outreach_client_visible(p_ws, cid) then
    raise exception 'E_FORBIDDEN: client not visible';
  end if;

  if existing is not null then
    update outreach_leads l set
      public_identifier = coalesce(l.public_identifier, pid),
      provider_id = coalesce(p_lead->>'provider_id', l.provider_id),
      profile_url = coalesce(p_lead->>'profile_url', l.profile_url),
      first_name = coalesce(nullif(p_lead->>'first_name',''), l.first_name),
      last_name = coalesce(nullif(p_lead->>'last_name',''), l.last_name),
      full_name = coalesce(nullif(p_lead->>'full_name',''), l.full_name),
      headline = coalesce(nullif(p_lead->>'headline',''), l.headline),
      company = coalesce(nullif(p_lead->>'company',''), l.company),
      company_id = coalesce(nullif(p_lead->>'company_id',''), l.company_id),
      title = coalesce(nullif(p_lead->>'title',''), l.title),
      location = coalesce(nullif(p_lead->>'location',''), l.location),
      phone = coalesce(nullif(p_lead->>'phone',''), l.phone),
      company_domain = coalesce(outreach_clean_domain(p_lead->>'company_domain'), l.company_domain),
      picture_url = coalesce(nullif(p_lead->>'picture_url',''), l.picture_url),
      email_work = coalesce(l.email_work, ew),
      email_personal = coalesce(l.email_personal, ep),
      is_open_profile = coalesce((p_lead->>'is_open_profile')::boolean, l.is_open_profile),
      custom = l.custom || coalesce(p_lead->'custom','{}'::jsonb),
      list_id = coalesce(lid, l.list_id),
      stage_id = coalesce(sid, l.stage_id),
      client_id = coalesce(l.client_id, cid),
      last_profile_fetch_at = case when coalesce((p_lead->>'profile_fetched')::boolean,false) then now() else l.last_profile_fetch_at end,
      updated_at = now()
    where l.id = existing;
    res_id := existing; res_created := false;
  else
    insert into outreach_leads(workspace_id, client_id, public_identifier, provider_id, profile_url, first_name, last_name, full_name, headline, company, company_id, title, location, picture_url, phone, company_domain,
      email_work, email_personal, is_open_profile, custom, list_id, stage_id, source, import_job_id, last_profile_fetch_at)
    values (p_ws, cid, pid, p_lead->>'provider_id', p_lead->>'profile_url', nullif(p_lead->>'first_name',''), nullif(p_lead->>'last_name',''),
      coalesce(nullif(p_lead->>'full_name',''), nullif(trim(coalesce(p_lead->>'first_name','') || ' ' || coalesce(p_lead->>'last_name','')),'')),
      nullif(p_lead->>'headline',''), nullif(p_lead->>'company',''), nullif(p_lead->>'company_id',''), nullif(p_lead->>'title',''), nullif(p_lead->>'location',''), nullif(p_lead->>'picture_url',''), nullif(p_lead->>'phone',''), outreach_clean_domain(p_lead->>'company_domain'),
      ew, ep, (p_lead->>'is_open_profile')::boolean, coalesce(p_lead->'custom','{}'::jsonb), lid, sid, p_source, p_import_job,
      case when coalesce((p_lead->>'profile_fetched')::boolean,false) then now() else null end)
    returning outreach_leads.id into nid;
    if nid is null then
      -- lost a race on the unique index; re-resolve
      select l.id into nid from outreach_leads l where l.workspace_id = p_ws and ((pid is not null and l.public_identifier = pid) or (ew is not null and l.email_work = ew)) limit 1;
      res_id := nid; res_created := false;
    else
      perform outreach_emit_event(p_ws, 'lead.created', jsonb_build_object('id', nid, 'public_identifier', pid, 'source', p_source));
      res_id := nid; res_created := true;
    end if;
  end if;

  if res_id is not null then
    for it in select * from jsonb_array_elements(idents) loop
      perform outreach__identity_upsert(p_ws, res_id, upper(it->>'provider')::outreach_provider_t, it->>'identifier',
        coalesce(nullif(it->>'source',''), case when p_import_job is not null then 'import' else coalesce(nullif(p_source,''), 'operator') end),
        coalesce((it->>'verified')::boolean, true), it->>'provider_id');
    end loop;
  end if;
  id := res_id; created := res_created; return next;
exception when unique_violation then
  select l.id into nid from outreach_leads l where l.workspace_id = p_ws and ((pid is not null and l.public_identifier = pid) or (ew is not null and l.email_work = ew)) limit 1;
  id := nid; created := false; return next;
end $$;

-- -----------------------------------------------------------------------------
-- Cron: the channel workers (contract §4)
-- -----------------------------------------------------------------------------
do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('outreach-followers-poll','outreach-identifier-check','outreach-block-detect','outreach-transcribe') loop perform cron.unschedule(j.jobid); end loop;
end $$;
select cron.schedule('outreach-followers-poll',   '35 * * * *',   $$select outreach_invoke('outreach-worker-channels', '{"mode":"followers_poll"}'::jsonb)$$);     -- Instagram follow-back detection (1–3 polls/day/sender)
select cron.schedule('outreach-identifier-check', '*/30 * * * *', $$select outreach_invoke('outreach-worker-channels', '{"mode":"identifier_check"}'::jsonb)$$);   -- WhatsApp "is this number on?" before a new chat
select cron.schedule('outreach-block-detect',     '55 * * * *',   $$select outreach_invoke('outreach-worker-channels', '{"mode":"block_detect"}'::jsonb)$$);       -- one-way chats and failed sends after a first message
select cron.schedule('outreach-transcribe',       '* * * * *',    $$select outreach_invoke('outreach-worker-channels', '{"mode":"transcribe"}'::jsonb)$$);         -- voice notes → transcript → classifier

-- -----------------------------------------------------------------------------
-- Grants (same footer as 023 / 017): nothing for anon or PUBLIC; service_role everywhere; signed-in users only on the
-- user-facing RPCs; internal helpers and service functions closed; search_path fixed on every function touched here.
-- -----------------------------------------------------------------------------
do $$
declare f record;
  user_fns text[] := array['outreach_normalize_phone','outreach_normalize_handle','outreach_identity_add','outreach_identity_list','outreach_identity_verify','outreach_identity_remove',
    'outreach_consent_grant','outreach_consent_revoke','outreach_consent_list','outreach_consent_report','outreach_channel_caps','outreach_sender_hour','outreach_sender_scopes_today',
    'outreach_channel_capacity','outreach_sender_attest_account_age','outreach_sender_resume_after_warning','outreach_report_channels','outreach_report_blocks','outreach_metric_definitions',
    'outreach_reason_text','outreach_action_label','outreach_why_not_sending','outreach_validate_graph','outreach_enroll_preview','outreach_enroll_leads','outreach_upsert_lead','outreach_set_manual_caps',
    'outreach_sender_insights','outreach_project_sequence','outreach_node_types','outreach_node_action_type','outreach_is_executable_node'];
  internal_fns text[] := array['outreach_lead_identity','outreach_identity_set_check','outreach_lead_has_consent','outreach_consent_grant_system','outreach_consent_revoke_stop',
    'outreach_scoped_types','outreach_effective_total_cap','outreach_ensure_hour_budget','outreach_sender_min_gap','outreach_sender_provider_warning','outreach_record_block','outreach_wa_governor',
    'outreach_effective_cap','outreach_plan_budgets','outreach_reserve_budget','outreach_consume_budget','outreach_release_budget','outreach_claim_due_actions','outreach_complete_action',
    'outreach_fail_action','outreach_sweep_stale_reservations','outreach_planner_demand','outreach_health_inputs','outreach_enter_node','outreach_release_waits',
    'outreach_trg_reply_exit','outreach_trg_relation','outreach_trg_sender_quiet_period','outreach_trg_sequence_pools','outreach_lead_suppression_reason'];
begin
  for f in select p.oid::regprocedure::text as sig, p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname = any(user_fns) or p.proname = any(internal_fns) or p.proname like 'outreach\_\_%') loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname = any(user_fns) then execute format('grant execute on function %s to authenticated', f.sig);
    else execute format('revoke execute on function %s from authenticated', f.sig); end if;
    if f.proconfig is null or not exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%') then
      execute format('alter function %s set search_path = public, extensions', f.sig);
    end if;
  end loop;
end $$;
