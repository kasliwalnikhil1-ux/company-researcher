-- 080: catalogue syncs that a store rate-limits get a second way in.
--
-- Shopify (and the Cloudflare in front of many stores) answers 429 to the edge runtime's shared outbound addresses,
-- while the same request from the database server is answered 200 (polkistories.com, 2026-10-06: every worker run got
-- 429; from the database the 250-product page came back in 0.5 s). The knowledge worker now asks for a store page
-- through the database when the store turns it away (catalogue.ts `fetchViaDb`) and keeps that route for the sync.
--
--   outreach_catalogue_fetch(url, accept) → {status, content_type, location, retry_after, body}   (service only)
--
-- Synchronous, through the `http` extension. pg_net was tried first: its answers took 30–47 s to land and reading them
-- back meant scanning net._http_response (no index on id, 666 MB heap for ~9k rows), past PostgREST's 8 s timeout.
--
-- Both libraries follow redirects and neither lets that be switched off, so the route is narrow on purpose: only the
-- Shopify / WooCommerce product-list endpoints, only public hostnames (the worker checks the address too), 7 s at most,
-- and what comes back is only kept when it parses as a product list.
-- outreach__ks_json also shows a running sync's retries (catalogue.retry), so the screen can say why it is taking long.

create extension if not exists http with schema extensions;

drop function if exists outreach_catalogue_fetch(text, text, int);
drop function if exists outreach_catalogue_fetch_result(bigint);

create or replace function outreach_catalogue_fetch(p_url text, p_accept text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r extensions.http_response; host text; out jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if coalesce(p_url, '') !~* '^https?://[^[:space:]/?#@]+(/[^[:space:]]*)?$' or length(p_url) > 2000 then raise exception 'E_PAYLOAD_INVALID: not a link'; end if;
  host := lower(substring(p_url from '^[a-zA-Z]+://([^/?#:]+)'));
  if host !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$'            -- a name, never an IP literal
     or host ~ '(^|\.)(localhost|local|internal|supabase\.co|supabase\.com|amazonaws\.com)$' then
    raise exception 'E_PAYLOAD_INVALID: that address cannot be read from here';
  end if;
  if substring(p_url from '^[a-zA-Z]+://[^/?#]+(/[^?#]*)') not in ('/products.json', '/meta.json', '/cart.js')
     and substring(p_url from '^[a-zA-Z]+://[^/?#]+(/[^?#]*)') !~ '^(/[^?#]*)?/wp-json/wc/store/v1/products$' then
    raise exception 'E_PAYLOAD_INVALID: only store product lists are read this way';
  end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '7');
  begin
    r := extensions.http(('GET', p_url,
      array[extensions.http_header('user-agent', 'Mozilla/5.0 (compatible; GrowthxAI-catalogue/1.0)'),
            extensions.http_header('accept', coalesce(nullif(p_accept, ''), 'application/json'))], null, null)::extensions.http_request);
  exception when others then
    perform extensions.http_reset_curlopt();
    return jsonb_build_object('status', null, 'error', left(sqlerrm, 200));
  end;
  perform extensions.http_reset_curlopt();
  out := jsonb_build_object('status', r.status, 'content_type', r.content_type,
    'location', (select h.value from unnest(r.headers) h where lower(h.field) = 'location' limit 1),
    'retry_after', (select h.value from unnest(r.headers) h where lower(h.field) = 'retry-after' limit 1),
    'body', left(r.content, 40 * 1024 * 1024));
  return out;
end $$;

-- Same as 068, plus `retry` on a catalogue whose sync is being tried again: {tries, note}.
create or replace function outreach__ks_json(s outreach_knowledge_sources) returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object('id', s.id, 'kind', s.kind, 'title', s.title, 'url', s.url, 'storage_path', s.storage_path, 'content_type', s.content_type, 'status', s.status, 'error', s.error,
    'pages', s.pages, 'chunks', s.chunks, 'crawled_at', s.crawled_at, 'refresh_days', s.refresh_days, 'created_at', s.created_at, 'updated_at', s.updated_at,
    'detect_products', s.detect_products,
    'catalogue', case when s.catalogue is null then null else (s.catalogue - 'sync') || jsonb_build_object('syncing', s.catalogue ? 'sync' or (s.kind = 'catalogue' and s.status in ('pending', 'crawling')))
      || case when coalesce(s.catalogue#>>'{sync,errors}', '') ~ '^[1-9][0-9]*$'
              then jsonb_build_object('retry', jsonb_build_object('tries', (s.catalogue#>>'{sync,errors}')::int, 'note', left(s.catalogue#>>'{sync,note}', 300)))
              else '{}'::jsonb end end,
    'products', case when s.kind = 'catalogue' or s.detect_products then (select count(*) from outreach_products p where p.source_id = s.id and p.deleted_at is null) end,
    'used_by', (select count(*) from outreach_master_prompts mp where s.id = any(mp.knowledge_source_ids))
             + (select count(*) from outreach_webchat_inboxes i where i.workspace_id = s.workspace_id and i.deleted_at is null
                 and (coalesce(i.settings#>'{ai,knowledge_source_ids}', '[]'::jsonb) ? s.id::text or coalesce(i.settings#>'{ai,products,catalogue_ids}', '[]'::jsonb) ? s.id::text)))
$$;

revoke all on function outreach_catalogue_fetch(text, text) from public, anon, authenticated;
grant execute on function outreach_catalogue_fetch(text, text) to service_role;

-- The extension's own functions are open to PUBLIC by default: only the server may make the database fetch a link.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text sig from pg_proc p join pg_depend d on d.objid = p.oid and d.deptype = 'e'
            join pg_extension e on e.oid = d.refobjid where e.extname = 'http' loop
    begin execute format('grant execute on function %s to postgres', f.sig);   -- outreach_catalogue_fetch runs as postgres
          execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    exception when others then raise notice 'could not revoke %: %', f.sig, sqlerrm; end;
  end loop;
end $$;
