-- 068_webchat_buttons_products.sql — Web chat: your own buttons, Ask AI buttons, product recommendations
-- (web-chat-buttons-products-changes.md; as built: docs/outreach/WEBCHAT.md "Widget update 5").
-- Requires 001–065 (066 / 067 are the AI fields files and are not needed here). Idempotent.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/068_webchat_buttons_products.sql
--
--   1. Schema      a knowledge source can be a product catalogue (kind 'catalogue'); a website source can also collect the
--                  products it finds (detect_products). outreach_products holds the catalogue. An AI turn and a Review
--                  suggestion remember the cards they showed.
--   2. Settings    launcher.campaigns_open, ask_buttons[], selection_ask, shortcut, ai.products: defaults, validation on
--                  save, and the public projection the widget reads.
--   3. Catalogue   the sync worker's functions (begin / upsert / progress / finish), search and "which product is this".
--   4. App RPCs    outreach_hub_* (the 037 / 042 / 051 grant loops take `authenticated` off every outreach_knowledge_* and
--                  outreach_webchat* function that is not in their lists; see the grant-loop gotcha).
--   5. Patches     existing functions changed in place (pg_get_functiondef + replace, like 063). Every anchor is
--                  asserted: a missing anchor stops the migration with the function's name and nothing is changed.

-- ===============================================================================================================
-- 0. In-place patch helper (dropped at the end of this file)
-- ===============================================================================================================
-- p_pairs = [old1, new1, old2, new2, ...]. Returns false when the function already carries p_marker.
create or replace function outreach_wbp__patch(p_fn text, p_marker text, p_pairs text[]) returns boolean
language plpgsql set search_path = public, extensions as $$
declare def text; i int := 1;
begin
  -- bodies applied from a CRLF checkout carry \r: strip it so the anchors match
  def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  if position(p_marker in def) > 0 then return false; end if;
  while i < coalesce(array_length(p_pairs, 1), 0) loop
    if position(p_pairs[i] in def) = 0 then raise exception '068: % anchor not found: %', p_fn, left(p_pairs[i], 120); end if;
    def := replace(def, p_pairs[i], p_pairs[i + 1]);
    i := i + 2;
  end loop;
  if position(p_marker in def) = 0 then raise exception '068: % marker missing after the patch: %', p_fn, p_marker; end if;
  execute def;
  return true;
end $$;
revoke all on function outreach_wbp__patch(text, text, text[]) from public, anon, authenticated;

-- ===============================================================================================================
-- 1. Schema
-- ===============================================================================================================
-- ---- catalogues are knowledge sources
alter table outreach_knowledge_sources drop constraint if exists outreach_knowledge_sources_kind_check;
alter table outreach_knowledge_sources add constraint outreach_knowledge_sources_kind_check
  check (kind in ('website', 'document', 'text', 'catalogue'));
alter table outreach_knowledge_sources
  -- {provider: shopify | woocommerce | feed | csv | crawl, url, store, currency, currency_locked, products, synced_at, complete,
  --  warning, sync: {started_at, page, seen, rejected}  (only while a sync is running)}
  add column if not exists catalogue       jsonb,
  add column if not exists detect_products boolean not null default false;   -- website sources: "Also find products"

-- a catalogue's CSV is uploaded to the knowledge bucket
update storage.buckets set allowed_mime_types = (select array_agg(distinct m) from unnest(allowed_mime_types || array['text/csv', 'text/tab-separated-values']) m)
 where id = 'outreach-knowledge' and allowed_mime_types is not null and not (allowed_mime_types @> array['text/csv', 'text/tab-separated-values']);

-- ---- helpers the table needs
create or replace function outreach_product__num(t text) returns numeric
language sql immutable parallel safe set search_path = public, extensions as $$
  select case when btrim(coalesce(t, '')) ~ '^[0-9]{1,14}(\.[0-9]{1,6})?$' then btrim(t)::numeric end
$$;

-- What the search reads: title (A) · type, vendor, tags, option values (B) · description (C). 'simple' on purpose: product
-- names are not English prose, and the query side does its own light plural folding (outreach_product__search).
create or replace function outreach_product__tsv(p_title text, p_type text, p_vendor text, p_tags text[], p_options jsonb, p_description text) returns tsvector
language sql immutable parallel safe set search_path = public, extensions as $$
  select setweight(to_tsvector('simple', coalesce(p_title, '')), 'A')
      || setweight(to_tsvector('simple', coalesce(p_type, '') || ' ' || coalesce(p_vendor, '') || ' ' || coalesce(array_to_string(p_tags, ' '), '') || ' '
           || coalesce((select string_agg(v, ' ') from jsonb_each(case when jsonb_typeof(p_options) = 'object' then p_options else '{}'::jsonb end) e,
                          jsonb_array_elements_text(case when jsonb_typeof(e.value) = 'array' then e.value else '[]'::jsonb end) v), '')), 'B')
      || setweight(to_tsvector('simple', coalesce(p_description, '')), 'C')
$$;

-- One spelling per product page: no scheme, no www., no query string, no trailing slash, and Shopify's
-- /collections/<c>/products/<h> read as /products/<h>.
create or replace function outreach_product__url_key(u text) returns text
language sql immutable parallel safe set search_path = public, extensions as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(btrim(coalesce(u, ''))), '[?#].*$', ''), '^[a-z]+://(www\.)?', ''), '/collections/[^/]+/products/', '/products/'), '/+$', '')
$$;

create table if not exists outreach_products (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references outreach_workspaces(id) on delete cascade,
  source_id        uuid not null references outreach_knowledge_sources(id) on delete cascade,
  external_id      text not null,                 -- Shopify product id / Woo id / feed id / page URL
  handle           text,
  sku              text,
  url              text not null,
  title            text not null,
  description      text,                          -- plain text, 2,000 characters at most
  vendor           text,
  product_type     text,
  tags             text[] not null default '{}',
  options          jsonb not null default '{}',   -- {Color: [...], Size: [...]}
  price            numeric,
  compare_at_price numeric,
  currency         text,
  available        boolean not null default true,
  image_url        text,
  images           text[] not null default '{}',
  variants         jsonb not null default '[]',   -- 50 at most: {id, title, price, available, sku}
  pinned_keywords  text[] not null default '{}',
  ai_hidden        boolean not null default false,
  search           tsvector generated always as (outreach_product__tsv(title, product_type, vendor, tags, options, description)) stored,
  seen_at          timestamptz not null default now(),
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (source_id, external_id)
);
create index if not exists outreach_products_search_idx on outreach_products using gin (search);
create index if not exists outreach_products_title_trgm on outreach_products using gin (title gin_trgm_ops);
create index if not exists outreach_products_urlkey_idx on outreach_products (workspace_id, outreach_product__url_key(url));
create index if not exists outreach_products_handle_idx on outreach_products (workspace_id, lower(handle));
create index if not exists outreach_products_sku_idx on outreach_products (workspace_id, lower(sku));
create index if not exists outreach_products_source_idx on outreach_products (source_id, seen_at) where deleted_at is null;
alter table outreach_products enable row level security;   -- no policies, like outreach_knowledge_chunks: the app reads through outreach_hub_* RPCs
revoke all on outreach_products from anon, authenticated;

-- ---- what an answer showed, and from where it was asked
alter table outreach_webchat_ai_turns
  add column if not exists products       jsonb not null default '[]',   -- ids of the cards shown, in order
  add column if not exists context        text,                          -- the button's context (data-growthxai-context, a selection, "product:<ref>")
  add column if not exists product_id     uuid references outreach_products(id) on delete set null,   -- the product the visitor was looking at
  add column if not exists product_search jsonb;                         -- {q, min_price, max_price, found, shopping}: "asked for, not found" in the report
alter table outreach_webchat_ai_suggestions add column if not exists products jsonb not null default '[]';   -- card snapshots of a Review suggestion

-- the report's product numbers read three event names
create index if not exists outreach_webchat_events_product_idx on outreach_webchat_events(at) where name in ('product:shown', 'product:clicked', 'product:added_to_cart');

-- ===============================================================================================================
-- 2. Products: card snapshot, search, "which product is this"
-- ===============================================================================================================
-- The card as it is stored on a message and drawn by the widget and the inbox. Built from catalogue data only.
create or replace function outreach_product__card(p outreach_products, p_provider text) returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p.id, 'title', p.title, 'price', p.price,
    'compare_at', case when p.compare_at_price is not null and p.price is not null and p.compare_at_price > p.price then p.compare_at_price end,
    'currency', p.currency, 'url', p.url, 'image', p.image_url, 'available', p.available,
    -- Add to cart is a Shopify call (/cart/add.js) with a variant id: the first one that can be bought
    'variant_id', case when p_provider = 'shopify' and p.available then
        (select v->>'id' from jsonb_array_elements(p.variants) with ordinality t(v, n)
          where v->>'id' is not null and coalesce(v->>'available', 'true') <> 'false' order by n limit 1) end))
$$;

-- p_filters: {min_price, max_price, lt_price, gt_price, include_oos, include_hidden, complement, browse}
--   complement  "what goes with this": a different type that shares tags with the current product
--   browse      an empty question lists the catalogue (the agent's product picker)
create or replace function outreach_product__search(p_ws uuid, p_sources uuid[], p_query text, p_filters jsonb, p_current uuid, p_limit int) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  lim int := greatest(1, least(coalesce(p_limit, 12), 50));
  qtxt text := lower(left(btrim(coalesce(p_query, '')), 300));
  -- words that say "I am shopping" or carry an amount, never what is wanted
  stop constant text[] := array['show','me','the','a','an','any','some','do','does','did','you','your','have','has','got','sell','selling','i','im','am','we','us','want','wants','need','needs',
    'would','like','looking','look','for','find','search','get','buy','buying','purchase','is','are','was','there','what','which','whats','can','could','should','please','of','in','on','at','to',
    'with','and','or','under','below','above','over','between','than','less','more','around','about','upto','up','within','budget','price','priced','prices','cost','costs','range','cheap',
    'cheaper','cheapest','expensive','affordable','similar','something','anything','this','that','these','those','it','its','one','ones','my','our','best','good','nice','great','options',
    'option','recommend','recommended','suggest','suggestion','suggestions','tell','give','see','also','but','not','no','yes','ok','okay','hi','hello','hey','thanks','thank','rs','inr','usd',
    'eur','gbp','aed','rupees','rupee','dollars','dollar','lakh','lakhs','lac','lacs','crore','crores','cr','k','goes','go','match','matches','matching','from','by','be','as','so','if','how',
    'much','many','available','stock','here','other','others','else','too','only','just','really','very','max','min','maximum','minimum','items','item','products','product','stuff','things','thing'];
  w text; terms text[] := '{}'; words text[] := '{}'; q tsquery; qclean text;
  minp numeric := outreach_product__num(f->>'min_price'); maxp numeric := outreach_product__num(f->>'max_price');
  ltp numeric := outreach_product__num(f->>'lt_price'); gtp numeric := outreach_product__num(f->>'gt_price');
  oos boolean := coalesce(f->>'include_oos', '') = 'true'; hid boolean := coalesce(f->>'include_hidden', '') = 'true';
  comp boolean := coalesce(f->>'complement', '') = 'true'; browse boolean := coalesce(f->>'browse', '') = 'true';
  cur outreach_products%rowtype; out_ jsonb := '[]'::jsonb;
begin
  if p_ws is null or p_sources is null or cardinality(p_sources) = 0 then return '[]'::jsonb; end if;
  if p_current is not null then select * into cur from outreach_products where id = p_current and workspace_id = p_ws; end if;
  for w in select lexeme from unnest(to_tsvector('simple', qtxt)) loop
    if length(w) < 2 or w = any(stop) or w ~ '^[0-9][0-9.,]*$' then continue; end if;
    words := words || w;
    -- light plural folding; every term is a prefix match, so cutting a little too much costs nothing
    if w ~ '(sses|shes|ches|xes|zes)$' then w := left(w, length(w) - 2);
    elsif length(w) > 4 and w ~ 'ies$' then w := left(w, length(w) - 3);
    elsif length(w) > 3 and w ~ '[^su]s$' then w := left(w, length(w) - 1); end if;
    terms := terms || ('''' || replace(replace(w, '\', '\\'), '''', '''''') || ''':*');
  end loop;
  if cardinality(terms) > 0 then
    begin q := to_tsquery('simple', array_to_string(terms, ' | ')); exception when others then q := null; end;
    qclean := array_to_string(words, ' ');
  end if;

  if q is not null or qtxt <> '' then
    select coalesce(jsonb_agg(x.j order by x.score desc, x.available desc, x.price nulls last, x.title), '[]'::jsonb) into out_ from (
      select outreach_product__card(p, s.catalogue->>'provider') || jsonb_build_object('product_type', p.product_type, 'vendor', p.vendor, 'tags', to_jsonb(p.tags[1:8]),
               'description', left(coalesce(p.description, ''), 160), 'source_id', p.source_id, 'ai_hidden', p.ai_hidden, 'score', round(sc.score::numeric, 4)) j,
             sc.score, p.available, p.price, p.title
        from outreach_products p join outreach_knowledge_sources s on s.id = p.source_id
        cross join lateral (select exists (select 1 from unnest(p.pinned_keywords) k where btrim(k) <> '' and position(lower(btrim(k)) in qtxt) > 0) as pinned) pin
        cross join lateral (select
            (case when q is not null then ts_rank(p.search, q) else 0 end)
          + (case when qclean is not null then similarity(p.title, qclean) else 0 end)
          + (case when pin.pinned then 1 else 0 end)
          + (case when cur.id is not null and cur.product_type is not null and lower(coalesce(p.product_type, '')) = lower(cur.product_type) then 0.3 else 0 end)
          + (case when cur.id is not null then least(0.3, 0.1 * cardinality(array(select unnest(p.tags) intersect select unnest(cur.tags)))) else 0 end) as score) sc
       where p.workspace_id = p_ws and p.source_id = any(p_sources) and p.deleted_at is null and (hid or not p.ai_hidden) and (oos or p.available)
         and (cur.id is null or p.id <> cur.id)
         and (minp is null or p.price >= minp) and (maxp is null or p.price <= maxp) and (ltp is null or p.price < ltp) and (gtp is null or p.price > gtp)
         and ((q is not null and p.search @@ q) or (qclean is not null and p.title % qclean) or pin.pinned)
       order by sc.score desc, p.available desc, p.price nulls last, p.title limit lim) x;
  end if;

  -- nothing matched the words: fall back to the product the visitor is looking at (same type; or, for "what goes with
  -- this", another type that shares tags or the brand)
  if out_ = '[]'::jsonb and cur.id is not null then
    select coalesce(jsonb_agg(x.j order by x.ov desc, x.available desc, x.gap nulls last, x.title), '[]'::jsonb) into out_ from (
      select outreach_product__card(p, s.catalogue->>'provider') || jsonb_build_object('product_type', p.product_type, 'vendor', p.vendor, 'tags', to_jsonb(p.tags[1:8]),
               'description', left(coalesce(p.description, ''), 160), 'source_id', p.source_id, 'ai_hidden', p.ai_hidden, 'score', 0) j,
             cardinality(array(select unnest(p.tags) intersect select unnest(cur.tags))) ov, p.available, abs(p.price - cur.price) gap, p.title
        from outreach_products p join outreach_knowledge_sources s on s.id = p.source_id
       where p.workspace_id = p_ws and p.source_id = any(p_sources) and p.deleted_at is null and (hid or not p.ai_hidden) and (oos or p.available) and p.id <> cur.id
         and (minp is null or p.price >= minp) and (maxp is null or p.price <= maxp) and (ltp is null or p.price < ltp) and (gtp is null or p.price > gtp)
         and case when comp then lower(coalesce(p.product_type, '')) is distinct from lower(coalesce(cur.product_type, '')) and (p.tags && cur.tags or (cur.vendor is not null and p.vendor = cur.vendor))
                  else (cur.product_type is not null and lower(coalesce(p.product_type, '')) = lower(cur.product_type)) or (cur.product_type is null and p.tags && cur.tags) end
       order by 2 desc, p.available desc, 4 nulls last, p.title limit lim) x;
  end if;

  -- no words at all: a budget alone ("anything under 5,000?") lists what fits, dearest first; the picker lists the catalogue
  if out_ = '[]'::jsonb and cur.id is null and cardinality(terms) = 0 and (browse or coalesce(minp, maxp, ltp, gtp) is not null) then
    select coalesce(jsonb_agg(x.j order by x.pinned desc, x.available desc, x.price desc nulls last, x.title), '[]'::jsonb) into out_ from (
      select outreach_product__card(p, s.catalogue->>'provider') || jsonb_build_object('product_type', p.product_type, 'vendor', p.vendor, 'tags', to_jsonb(p.tags[1:8]),
               'description', left(coalesce(p.description, ''), 160), 'source_id', p.source_id, 'ai_hidden', p.ai_hidden, 'score', 0) j,
             cardinality(p.pinned_keywords) > 0 pinned, p.available, p.price, p.title
        from outreach_products p join outreach_knowledge_sources s on s.id = p.source_id
       where p.workspace_id = p_ws and p.source_id = any(p_sources) and p.deleted_at is null and (hid or not p.ai_hidden) and (oos or p.available)
         and (minp is null or p.price >= minp) and (maxp is null or p.price <= maxp) and (ltp is null or p.price < ltp) and (gtp is null or p.price > gtp)
       order by 2 desc, p.available desc, p.price desc nulls last, p.title limit lim) x;
  end if;
  return out_;
end $$;

-- The assistant's search (service only).
create or replace function outreach_product_search(p_ws uuid, p_sources uuid[], p_query text, p_filters jsonb default '{}', p_current uuid default null, p_limit int default 12) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return outreach_product__search(p_ws, p_sources, p_query, p_filters, p_current, p_limit);
end $$;

-- `product:<handle | sku | url | id>` from a button, or a page URL → the product, or null.
create or replace function outreach_product__resolve(p_ws uuid, p_sources uuid[], p_ref text) returns uuid
language plpgsql stable security definer set search_path = public, extensions as $$
declare ref text := btrim(regexp_replace(btrim(coalesce(p_ref, '')), '^product:', '', 'i')); key text; h text; pid uuid;
begin
  if ref = '' or p_ws is null or p_sources is null or cardinality(p_sources) = 0 then return null; end if;
  ref := left(ref, 2000);
  if ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select p.id into pid from outreach_products p where p.id = ref::uuid and p.workspace_id = p_ws and p.source_id = any(p_sources) and p.deleted_at is null;
    return pid;
  end if;
  if ref ~* '^https?://' then
    key := outreach_product__url_key(ref);
    select p.id into pid from outreach_products p where p.workspace_id = p_ws and outreach_product__url_key(p.url) = key and p.source_id = any(p_sources) and p.deleted_at is null
     order by p.seen_at desc limit 1;
    if pid is not null then return pid; end if;
    -- the same product on another domain of the shop (a preview domain, a market sub-folder): its handle
    h := (regexp_match(key, '/products/([^/]+)$'))[1];
    if h is null then return null; end if;
    ref := h;
  end if;
  select p.id into pid from outreach_products p
   where p.workspace_id = p_ws and p.source_id = any(p_sources) and p.deleted_at is null
     and (lower(p.handle) = lower(ref) or lower(p.sku) = lower(ref) or p.external_id = ref or p.variants @> jsonb_build_array(jsonb_build_object('sku', ref)))
   order by (lower(p.handle) = lower(ref)) desc nulls last, p.seen_at desc limit 1;
  if pid is not null then return pid; end if;
  select p.id into pid from outreach_products p
   where p.workspace_id = p_ws and p.source_id = any(p_sources) and p.deleted_at is null and lower(p.title) = lower(ref)
   order by p.seen_at desc limit 1;
  return pid;
end $$;

create or replace function outreach_product_resolve(p_ws uuid, p_sources uuid[], p_ref text) returns uuid
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return outreach_product__resolve(p_ws, p_sources, p_ref);
end $$;

-- One product with what the prompt's CURRENT PRODUCT block needs (service only).
create or replace function outreach_product_get(p_ws uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select case when outreach_is_service() then (
    select outreach_product__card(p, s.catalogue->>'provider') || jsonb_build_object('product_type', p.product_type, 'vendor', p.vendor, 'tags', to_jsonb(p.tags[1:8]),
             'description', left(coalesce(p.description, ''), 400), 'options', p.options, 'source_id', p.source_id)
      from outreach_products p join outreach_knowledge_sources s on s.id = p.source_id
     where p.id = p_id and p.workspace_id = p_ws and p.deleted_at is null) end
$$;

-- ===============================================================================================================
-- 3. Catalogue sync (service: outreach-ai-reply-worker, mode `knowledge`)
-- ===============================================================================================================
-- A sync that does not fit one worker run keeps its place in catalogue.sync and is claimed again on the next tick.
create or replace function outreach_knowledge_claim(p_limit int default 3) returns setof outreach_knowledge_sources
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
    update outreach_knowledge_sources s set status = 'crawling', updated_at = now()
     where s.id in (select id from outreach_knowledge_sources
                     where status = 'pending' or (status = 'crawling' and updated_at < now() - interval '20 minutes')
                        or (status = 'crawling' and kind = 'catalogue' and catalogue ? 'sync' and updated_at < now() - interval '45 seconds')
                        or (status = 'ready' and refresh_days is not null and crawled_at < now() - make_interval(days => refresh_days))
                     order by updated_at limit greatest(1, least(p_limit, 10)) for update skip locked)
    returning s.*;
end $$;

-- Start a sync, or pick up the one that is running. started_at is the database clock: a product is "seen in this
-- sync" when its seen_at is not older.
create or replace function outreach_catalogue_begin(p_source uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_knowledge_sources%rowtype; cur jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_knowledge_sources where id = p_source for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  cur := s.catalogue->'sync';
  if jsonb_typeof(cur) = 'object' and (cur->>'started_at') is not null and (cur->>'started_at')::timestamptz > clock_timestamp() - interval '6 hours' then return cur; end if;
  cur := jsonb_build_object('started_at', clock_timestamp(), 'page', 1, 'seen', 0, 'rejected', 0);
  update outreach_knowledge_sources set catalogue = coalesce(catalogue, '{}'::jsonb) || jsonb_build_object('sync', cur), updated_at = now() where id = p_source;
  return cur;
end $$;

create or replace function outreach_catalogue_progress(p_source uuid, p_cursor jsonb) returns void
language sql security definer set search_path = public, extensions as $$
  update outreach_knowledge_sources set catalogue = coalesce(catalogue, '{}'::jsonb) || jsonb_build_object('sync', p_cursor), updated_at = now()
   where id = p_source and outreach_is_service() and jsonb_typeof(p_cursor) = 'object'
$$;

-- One batch (the worker sends 200 at a time). 10,000 products per catalogue: what does not fit is counted as rejected.
-- pinned_keywords and ai_hidden are the team's and survive every sync.
create or replace function outreach_catalogue_upsert(p_source uuid, p_products jsonb, p_started timestamptz) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_knowledge_sources%rowtype; cap constant int := 10000; room int; n_in int; n_up int; lock_cur text; def_cur text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_knowledge_sources where id = p_source for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  def_cur := case when upper(coalesce(s.catalogue->>'currency', '')) ~ '^[A-Z]{3}$' then upper(s.catalogue->>'currency') end;
  lock_cur := case when coalesce(s.catalogue->>'currency_locked', '') = 'true' then def_cur end;
  select greatest(0, cap - count(*))::int into room from outreach_products where source_id = p_source and deleted_at is null and seen_at >= p_started;
  with inc as (
    select distinct on (ext) * from (
      select left(btrim(coalesce(x->>'external_id', '')), 300) ext, o,
             nullif(left(btrim(coalesce(x->>'handle', '')), 300), '') handle, nullif(left(btrim(coalesce(x->>'sku', '')), 120), '') sku,
             left(btrim(coalesce(x->>'url', '')), 2000) url,
             left(btrim(regexp_replace(coalesce(x->>'title', ''), '\s+', ' ', 'g')), 300) title,
             nullif(left(btrim(coalesce(x->>'description', '')), 2000), '') description,
             nullif(left(btrim(coalesce(x->>'vendor', '')), 200), '') vendor, nullif(left(btrim(coalesce(x->>'product_type', '')), 200), '') product_type,
             coalesce((select array_agg(left(btrim(v), 80) order by n) from jsonb_array_elements_text(case when jsonb_typeof(x->'tags') = 'array' then x->'tags' else '[]'::jsonb end) with ordinality tt(v, n)
                        where btrim(v) <> '' and n <= 50), '{}') tags,
             case when jsonb_typeof(x->'options') = 'object' and length((x->'options')::text) <= 4000 then x->'options' else '{}'::jsonb end options,
             outreach_product__num(x->>'price') price, outreach_product__num(x->>'compare_at_price') compare_at,
             case when upper(coalesce(x->>'currency', '')) ~ '^[A-Z]{3}$' then upper(x->>'currency') end currency,
             coalesce(x->>'available', 'true') <> 'false' available,
             case when (x->>'image_url') ~* '^https?://[^[:space:]"<>]+$' then left(x->>'image_url', 2000) end image_url,
             coalesce((select array_agg(left(v, 2000) order by n) from jsonb_array_elements_text(case when jsonb_typeof(x->'images') = 'array' then x->'images' else '[]'::jsonb end) with ordinality im(v, n)
                        where v ~* '^https?://[^[:space:]"<>]+$' and n <= 10), '{}') images,
             coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', left(v->>'id', 120), 'title', left(v->>'title', 200), 'price', outreach_product__num(v->>'price'),
                                 'available', coalesce(v->>'available', 'true') <> 'false', 'sku', nullif(left(coalesce(v->>'sku', ''), 120), ''))) order by n)
                         from jsonb_array_elements(case when jsonb_typeof(x->'variants') = 'array' then x->'variants' else '[]'::jsonb end) with ordinality vv(v, n)
                        where jsonb_typeof(v) = 'object' and n <= 50), '[]'::jsonb) variants
        from jsonb_array_elements(case when jsonb_typeof(p_products) = 'array' then p_products else '[]'::jsonb end) with ordinality t(x, o)
       where jsonb_typeof(x) = 'object') z
     where ext <> '' and title <> '' and url ~* '^https?://[^[:space:]"<>]+$'
     order by ext, o),
  tagged as (
    select i.*, exists (select 1 from outreach_products e where e.source_id = p_source and e.external_id = i.ext and e.deleted_at is null and e.seen_at >= p_started) counted from inc i),
  pick as (
    select t.*, case when t.counted then 0 else row_number() over (partition by t.counted order by t.o) end rn from tagged t),
  ins as (
    insert into outreach_products(workspace_id, source_id, external_id, handle, sku, url, title, description, vendor, product_type, tags, options, price, compare_at_price, currency,
                                  available, image_url, images, variants, seen_at, deleted_at, updated_at)
    select s.workspace_id, p_source, k.ext, k.handle, k.sku, k.url, k.title, k.description, k.vendor, k.product_type, k.tags, k.options, k.price, k.compare_at,
           coalesce(lock_cur, k.currency, def_cur), k.available, coalesce(k.image_url, k.images[1]), k.images, k.variants, clock_timestamp(), null, now()
      from pick k where k.rn <= room
    on conflict (source_id, external_id) do update set handle = excluded.handle, sku = excluded.sku, url = excluded.url, title = excluded.title, description = excluded.description,
      vendor = excluded.vendor, product_type = excluded.product_type, tags = excluded.tags, options = excluded.options, price = excluded.price,
      compare_at_price = excluded.compare_at_price, currency = excluded.currency, available = excluded.available, image_url = excluded.image_url, images = excluded.images,
      variants = excluded.variants, seen_at = excluded.seen_at, deleted_at = null, updated_at = now()
    returning 1)
  select (select count(*) from inc), (select count(*) from ins) into n_in, n_up;
  update outreach_knowledge_sources set updated_at = now() where id = p_source;   -- the worker's heartbeat
  return jsonb_build_object('ok', true, 'received', n_in, 'upserted', n_up, 'rejected', n_in - n_up);
end $$;

-- End of a sync. p_complete = the whole source was read: products it no longer lists are marked deleted (never offered
-- again; cards already shown keep rendering from their saved copy). p_meta: {currency, store, pages, warning}.
create or replace function outreach_catalogue_finish(p_source uuid, p_started timestamptz, p_complete boolean, p_meta jsonb default '{}', p_error text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_knowledge_sources%rowtype; m jsonb := coalesce(p_meta, '{}'::jsonb); is_cat boolean; seen int; gone int := 0; live int; cur text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_knowledge_sources where id = p_source for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  is_cat := s.kind = 'catalogue';
  if p_error is null and coalesce(p_complete, false) and is_cat then
    select count(*) into seen from outreach_products where source_id = p_source and deleted_at is null and seen_at >= p_started;
    -- a complete read with nothing in it, while we hold products: a shop misbehaving is likelier than a shop emptied
    if seen = 0 and exists (select 1 from outreach_products where source_id = p_source and deleted_at is null) then
      p_error := 'The source returned no products. The products from the last sync are kept.';
    end if;
  end if;
  if p_error is not null then
    update outreach_knowledge_sources
       set catalogue = (coalesce(catalogue, '{}'::jsonb) - 'sync') || jsonb_build_object('last_error', left(p_error, 500), 'last_error_at', now()),
           status = case when is_cat then 'error' else status end, error = case when is_cat then left(p_error, 500) else error end, updated_at = now()
     where id = p_source;
    return jsonb_build_object('ok', true, 'status', 'error');
  end if;
  if coalesce(p_complete, false) then
    update outreach_products set deleted_at = now(), updated_at = now() where source_id = p_source and deleted_at is null and seen_at < p_started;
    get diagnostics gone = row_count;
  end if;
  select count(*) into live from outreach_products where source_id = p_source and deleted_at is null;
  cur := case when coalesce(s.catalogue->>'currency_locked', '') = 'true' and upper(coalesce(s.catalogue->>'currency', '')) ~ '^[A-Z]{3}$' then upper(s.catalogue->>'currency')
              when upper(coalesce(m->>'currency', '')) ~ '^[A-Z]{3}$' then upper(m->>'currency')
              when upper(coalesce(s.catalogue->>'currency', '')) ~ '^[A-Z]{3}$' then upper(s.catalogue->>'currency') end;
  update outreach_knowledge_sources
     set catalogue = (coalesce(catalogue, '{}'::jsonb) - 'sync' - 'last_error' - 'last_error_at' - 'warning')
                     || jsonb_strip_nulls(jsonb_build_object('products', live, 'synced_at', now(), 'complete', coalesce(p_complete, false), 'currency', cur,
                          'warning', nullif(left(coalesce(m->>'warning', ''), 300), ''), 'store', nullif(left(coalesce(m->>'store', ''), 300), '')))
                     || case when is_cat then '{}'::jsonb else jsonb_build_object('provider', 'crawl') end,
         status = case when is_cat then 'ready' else status end, error = case when is_cat then null else error end,
         pages = case when is_cat and (m->>'pages') ~ '^[0-9]{1,6}$' then (m->>'pages')::int else pages end, chunks = case when is_cat then 0 else chunks end,
         crawled_at = case when is_cat then now() else crawled_at end, updated_at = now()
   where id = p_source;
  -- a currency learnt at the end (the shop's own) fills the products that came without one
  if cur is not null then update outreach_products set currency = cur where source_id = p_source and currency is null; end if;
  return jsonb_build_object('ok', true, 'status', 'ready', 'products', live, 'removed', gone);
end $$;

-- ===============================================================================================================
-- 4. Settings: buttons, selection, shortcut, products
-- ===============================================================================================================
create or replace function outreach_webchat__url_rules_check(v jsonb, p_path text) returns void
language plpgsql immutable set search_path = public, extensions as $$
declare r jsonb;
begin
  if v is null or jsonb_typeof(v) = 'null' then return; end if;
  if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 20 then raise exception 'E_PAYLOAD_INVALID: % (a list, 20 rules at most)', p_path; end if;
  for r in select * from jsonb_array_elements(v) loop
    if jsonb_typeof(r) <> 'object' then raise exception 'E_PAYLOAD_INVALID: %', p_path; end if;
    if coalesce(r->>'op', '') not in ('contains', 'equals', 'starts_with', 'regex') then raise exception 'E_PAYLOAD_INVALID: %.op', p_path; end if;
    if coalesce(r->>'action', '') not in ('show', 'hide') then raise exception 'E_PAYLOAD_INVALID: %.action', p_path; end if;
    if jsonb_typeof(r->'value') is distinct from 'string' or length(r->>'value') > 500 then raise exception 'E_PAYLOAD_INVALID: %.value', p_path; end if;
  end loop;
end $$;

-- launcher.campaigns_open, ask_buttons[], selection_ask, shortcut, ai.products. Called first thing by
-- outreach_webchat__settings_check (which returns early when the inbox has no video bubble).
create or replace function outreach_webchat__buttons_check(ns jsonb) returns void
language plpgsql immutable set search_path = public, extensions as $$
declare b jsonb; k text; ids text[] := '{}'; v jsonb;
        modes constant text[] := array['bubble', 'drawer', 'sidebar', 'modal', 'inline'];
begin
  v := ns#>'{launcher,campaigns_open}';
  if v is not null and jsonb_typeof(v) not in ('boolean', 'null') then raise exception 'E_PAYLOAD_INVALID: launcher.campaigns_open'; end if;

  v := ns->'ask_buttons';
  if v is not null and jsonb_typeof(v) <> 'null' then
    if jsonb_typeof(v) <> 'array' then raise exception 'E_PAYLOAD_INVALID: ask_buttons'; end if;
    if jsonb_array_length(v) > 10 then raise exception 'E_PAYLOAD_INVALID: ask_buttons (10 buttons at most per website)'; end if;
    for b in select * from jsonb_array_elements(v) loop
      if jsonb_typeof(b) <> 'object' then raise exception 'E_PAYLOAD_INVALID: ask_buttons'; end if;
      if exists (select 1 from jsonb_object_keys(b) x where x not in ('id', 'kind', 'selector', 'position', 'label', 'style', 'icon', 'click', 'text', 'context', 'mode', 'url_rules', 'enabled')) then
        raise exception 'E_PAYLOAD_INVALID: ask_buttons (unknown field)'; end if;
      if jsonb_typeof(b->'id') is distinct from 'string' or (b->>'id') !~ '^[a-z0-9_-]{1,40}$' then raise exception 'E_PAYLOAD_INVALID: ask_buttons.id'; end if;
      if (b->>'id') = any(ids) then raise exception 'E_PAYLOAD_INVALID: ask_buttons (two buttons share an id)'; end if;
      ids := ids || (b->>'id');
      if coalesce(b->>'kind', '') not in ('header', 'element') then raise exception 'E_PAYLOAD_INVALID: ask_buttons.kind'; end if;
      if jsonb_typeof(b->'selector') is distinct from 'string' or btrim(b->>'selector') = '' or length(b->>'selector') > 200 or (b->>'selector') ~ '[<>{}]' then
        raise exception 'E_PAYLOAD_INVALID: ask_buttons.selector (a CSS selector, 200 characters at most)'; end if;
      if b->>'kind' = 'header' and coalesce(b->>'position', 'end') not in ('start', 'end') then raise exception 'E_PAYLOAD_INVALID: ask_buttons.position (start or end)'; end if;
      if b->>'kind' = 'element' and coalesce(b->>'position', 'after') not in ('before', 'after', 'inside') then raise exception 'E_PAYLOAD_INVALID: ask_buttons.position (before, after or inside)'; end if;
      if b ? 'label' and (jsonb_typeof(b->'label') <> 'string' or btrim(b->>'label') = '' or length(b->>'label') > 30) then raise exception 'E_PAYLOAD_INVALID: ask_buttons.label (30 characters at most)'; end if;
      if coalesce(b->>'style', 'filled') not in ('filled', 'outline', 'text', 'match') then raise exception 'E_PAYLOAD_INVALID: ask_buttons.style'; end if;
      foreach k in array array['icon', 'enabled'] loop
        if b ? k and jsonb_typeof(b->k) not in ('boolean', 'null') then raise exception 'E_PAYLOAD_INVALID: ask_buttons.%', k; end if;
      end loop;
      if coalesce(b->>'click', 'open') not in ('open', 'ask', 'prefill') then raise exception 'E_PAYLOAD_INVALID: ask_buttons.click'; end if;
      if b->>'kind' = 'header' and coalesce(b->>'click', 'open') <> 'open' then raise exception 'E_PAYLOAD_INVALID: ask_buttons.click (a header button opens the chat)'; end if;
      if b ? 'text' and jsonb_typeof(b->'text') not in ('string', 'null') then raise exception 'E_PAYLOAD_INVALID: ask_buttons.text'; end if;
      if length(coalesce(b->>'text', '')) > 300 then raise exception 'E_PAYLOAD_INVALID: ask_buttons.text (300 characters at most)'; end if;
      if coalesce(b->>'click', 'open') in ('ask', 'prefill') and btrim(coalesce(b->>'text', '')) = '' then raise exception 'E_PAYLOAD_INVALID: ask_buttons.text (the question or the text to prefill)'; end if;
      if coalesce(b->>'context', 'none') not in ('none', 'page', 'product') then raise exception 'E_PAYLOAD_INVALID: ask_buttons.context'; end if;
      if b->>'mode' is not null and not (b->>'mode' = any(modes)) then raise exception 'E_PAYLOAD_INVALID: ask_buttons.mode'; end if;
      perform outreach_webchat__url_rules_check(b->'url_rules', 'ask_buttons.url_rules');
    end loop;
  end if;

  v := ns->'selection_ask';
  if v is not null and jsonb_typeof(v) <> 'null' then
    if jsonb_typeof(v) <> 'object' then raise exception 'E_PAYLOAD_INVALID: selection_ask'; end if;
    if v ? 'enabled' and jsonb_typeof(v->'enabled') not in ('boolean', 'null') then raise exception 'E_PAYLOAD_INVALID: selection_ask.enabled'; end if;
    if v ? 'area' and (jsonb_typeof(v->'area') not in ('string', 'null') or length(coalesce(v->>'area', '')) > 200 or coalesce(v->>'area', '') ~ '[<>{}]') then raise exception 'E_PAYLOAD_INVALID: selection_ask.area (a CSS selector, 200 characters at most)'; end if;
    if v ? 'label' and (jsonb_typeof(v->'label') not in ('string', 'null') or length(coalesce(v->>'label', '')) > 30) then raise exception 'E_PAYLOAD_INVALID: selection_ask.label (30 characters at most)'; end if;
  end if;

  v := ns->'shortcut';
  if v is not null and jsonb_typeof(v) <> 'null' then
    if jsonb_typeof(v) <> 'object' or (v ? 'enabled' and jsonb_typeof(v->'enabled') not in ('boolean', 'null')) then raise exception 'E_PAYLOAD_INVALID: shortcut.enabled'; end if;
  end if;

  v := ns#>'{ai,products}';
  if v is not null and jsonb_typeof(v) <> 'null' then
    if jsonb_typeof(v) <> 'object' then raise exception 'E_PAYLOAD_INVALID: ai.products'; end if;
    foreach k in array array['enabled', 'show_prices', 'include_oos', 'add_to_cart', 'utm'] loop
      if v ? k and jsonb_typeof(v->k) not in ('boolean', 'null') then raise exception 'E_PAYLOAD_INVALID: ai.products.%', k; end if;
    end loop;
    if v ? 'max' and jsonb_typeof(v->'max') <> 'null' and (jsonb_typeof(v->'max') <> 'number' or (v->>'max') !~ '^[1-6]$') then raise exception 'E_PAYLOAD_INVALID: ai.products.max (1 to 6 cards per answer)'; end if;
    if v ? 'catalogue_ids' and jsonb_typeof(v->'catalogue_ids') <> 'null' then
      if jsonb_typeof(v->'catalogue_ids') <> 'array' or jsonb_array_length(v->'catalogue_ids') > 20 then raise exception 'E_PAYLOAD_INVALID: ai.products.catalogue_ids'; end if;
      if exists (select 1 from jsonb_array_elements(v->'catalogue_ids') x where jsonb_typeof(x) <> 'string' or (x#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
        raise exception 'E_PAYLOAD_INVALID: ai.products.catalogue_ids'; end if;
    end if;
  end if;
end $$;

-- The catalogues a website may recommend from: its picks that still exist in the workspace and hold at least one product.
create or replace function outreach_webchat__product_sources(p_ws uuid, st jsonb) returns uuid[]
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(array_agg(s.id order by x.n), '{}')
    from jsonb_array_elements_text(case when jsonb_typeof(st#>'{ai,products,catalogue_ids}') = 'array' then st#>'{ai,products,catalogue_ids}' else '[]'::jsonb end) with ordinality x(id, n)
    join outreach_knowledge_sources s on s.id::text = x.id and s.workspace_id = p_ws and (s.kind = 'catalogue' or s.detect_products)
   where exists (select 1 from outreach_products p where p.source_id = s.id and p.deleted_at is null)
$$;

-- "Add to cart" is Shopify's /cart/add.js, called from the page: only when a picked catalogue is a Shopify store that
-- is one of this website's allowed domains.
create or replace function outreach_webchat__add_to_cart_ok(p_inbox uuid, st jsonb) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(st#>>'{ai,products,add_to_cart}', '') = 'true' and exists (
    select 1 from outreach_webchat_inboxes i
      join outreach_knowledge_sources s on s.workspace_id = i.workspace_id and s.kind = 'catalogue' and s.catalogue->>'provider' = 'shopify'
     where i.id = p_inbox and s.id = any(outreach_webchat__product_sources(i.workspace_id, st))
       and (outreach_webchat__origin_ok(i.id, coalesce(s.catalogue->>'store', s.catalogue->>'url')) or outreach_webchat__origin_ok(i.id, s.catalogue->>'url')))
$$;

-- What the widget may know: never the catalogue ids.
create or replace function outreach_webchat__products_public(p_inbox uuid, st jsonb) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'enabled', coalesce(st#>>'{ai,products,enabled}', '') = 'true' and cardinality(outreach_webchat__product_sources(i.workspace_id, st)) > 0,
    'show_prices', coalesce(st#>>'{ai,products,show_prices}', 'true') <> 'false',
    'add_to_cart', outreach_webchat__add_to_cart_ok(i.id, st),
    'utm', coalesce(st#>>'{ai,products,utm}', 'true') <> 'false')
    from outreach_webchat_inboxes i where i.id = p_inbox
$$;

-- What the assistant needs to recommend, or null when it should not (off, or no catalogue with products).
create or replace function outreach_webchat__products_ctx(p_inbox uuid, st jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype; src uuid[];
begin
  if coalesce(st#>>'{ai,products,enabled}', '') <> 'true' then return null; end if;
  select * into i from outreach_webchat_inboxes where id = p_inbox;
  if not found then return null; end if;
  src := outreach_webchat__product_sources(i.workspace_id, st);
  if cardinality(src) = 0 then return null; end if;
  return jsonb_build_object('sources', to_jsonb(src),
    'max', greatest(1, least(6, case when (st#>>'{ai,products,max}') ~ '^[0-9]$' then (st#>>'{ai,products,max}')::int else 3 end)),
    'include_oos', coalesce(st#>>'{ai,products,include_oos}', '') = 'true',
    'show_prices', coalesce(st#>>'{ai,products,show_prices}', 'true') <> 'false',
    'add_to_cart', outreach_webchat__add_to_cart_ok(i.id, st),
    'currency', (select upper(s.catalogue->>'currency') from outreach_knowledge_sources s where s.id = src[1]));
end $$;

-- On save: picks that are not catalogues of this workspace are dropped, and recommending needs a catalogue with products.
-- Switching it on without one is refused; a restore or an unrelated save that finds none left switches it off instead.
create or replace function outreach_webchat__products_fix(p_ws uuid, ns jsonb, p_patch jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare ids jsonb; out_ jsonb := ns;
begin
  if jsonb_typeof(ns#>'{ai,products}') is distinct from 'object' then return ns; end if;
  if jsonb_typeof(ns#>'{ai,products,catalogue_ids}') = 'array' then
    select coalesce(jsonb_agg(x.id order by x.n), '[]'::jsonb) into ids
      from jsonb_array_elements_text(ns#>'{ai,products,catalogue_ids}') with ordinality x(id, n)
     where exists (select 1 from outreach_knowledge_sources s where s.id::text = x.id and s.workspace_id = p_ws and (s.kind = 'catalogue' or s.detect_products));
    out_ := jsonb_set(out_, '{ai,products,catalogue_ids}', ids);
  end if;
  if coalesce(out_#>>'{ai,products,enabled}', '') = 'true' and cardinality(outreach_webchat__product_sources(p_ws, out_)) = 0 then
    if coalesce(p_patch#>>'{settings,ai,products,enabled}', '') = 'true' and not (p_patch ? 'restored_from') then
      raise exception 'E_PAYLOAD_INVALID: add a product catalogue and wait until its products are in before switching on product recommendations';
    end if;
    out_ := jsonb_set(out_, '{ai,products,enabled}', 'false'::jsonb);
  end if;
  return out_;
end $$;

-- ===============================================================================================================
-- 5. Report: the Products block
-- ===============================================================================================================
create or replace function outreach_webchat__products_report(p_ws uuid, p_inbox uuid, f timestamptz, t timestamptz) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  with inb as (
    select i.id from outreach_webchat_inboxes i where i.workspace_id = p_ws and (p_inbox is null or i.id = p_inbox) and outreach_client_visible(p_ws, i.client_id)),
  turns as (
    select x.* from outreach_webchat_ai_turns x where x.workspace_id = p_ws and x.inbox_id in (select id from inb) and x.created_at >= f and x.created_at < t),
  ev as (
    select e.name, e.props, e.chat_id from outreach_webchat_events e join outreach_webchat_visitors v on v.id = e.visitor_id
     where e.name in ('product:shown', 'product:clicked', 'product:added_to_cart') and e.at >= f and e.at < t and v.workspace_id = p_ws and v.inbox_id in (select id from inb)),
  shown as (
    select x.id from ev e, jsonb_array_elements_text(case when jsonb_typeof(e.props->'ids') = 'array' then e.props->'ids' else '[]'::jsonb end) x(id) where e.name = 'product:shown'),
  rec as (
    select x.id from turns tu, jsonb_array_elements_text(tu.products) x(id)),
  clicked as (
    select e.props->>'id' id from ev e where e.name = 'product:clicked' and (e.props->>'id') is not null)
  select jsonb_build_object(
    'answers', (select count(*) from turns where answer is not null),
    'answers_with_products', (select count(*) from turns where jsonb_array_length(products) > 0),
    'cards_shown', (select count(*) from shown),
    'clicks', (select count(*) from clicked),
    'add_to_carts', (select count(*) from ev where name = 'product:added_to_cart'),
    'top_recommended', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'n', g.n, 'title', p.title, 'url', p.url, 'image', p.image_url, 'removed', p.deleted_at is not null) order by g.n desc, p.title), '[]'::jsonb)
                          from (select id, count(*) n from rec group by id order by 2 desc limit 10) g join outreach_products p on p.id::text = g.id and p.workspace_id = p_ws),
    'top_clicked', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'n', g.n, 'title', p.title, 'url', p.url, 'image', p.image_url, 'removed', p.deleted_at is not null) order by g.n desc, p.title), '[]'::jsonb)
                      from (select id, count(*) n from clicked group by id order by 2 desc limit 10) g join outreach_products p on p.id::text = g.id and p.workspace_id = p_ws),
    -- the visitor was shopping and got no card: the price filter or the question found nothing
    'not_found', (select coalesce(jsonb_agg(jsonb_build_object('query', left(y.query, 160), 'chat_id', y.chat_id, 'at', y.created_at) order by y.created_at desc), '[]'::jsonb)
                    from (select tu.query, tu.chat_id, tu.created_at from turns tu
                           where tu.product_search is not null and jsonb_array_length(tu.products) = 0
                             and (coalesce(tu.product_search->>'shopping', '') = 'true'
                                  or (coalesce(tu.product_search->>'found', '0') = '0' and (tu.product_search ? 'min_price' or tu.product_search ? 'max_price')))
                           order by tu.created_at desc limit 30) y))
$$;

-- ===============================================================================================================
-- 6. App RPCs (outreach_hub_*)
-- ===============================================================================================================
-- "Used by" counts the websites that recommend from a catalogue; the source carries its catalogue state and product count.
create or replace function outreach__ks_json(s outreach_knowledge_sources) returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object('id', s.id, 'kind', s.kind, 'title', s.title, 'url', s.url, 'storage_path', s.storage_path, 'content_type', s.content_type, 'status', s.status, 'error', s.error,
    'pages', s.pages, 'chunks', s.chunks, 'crawled_at', s.crawled_at, 'refresh_days', s.refresh_days, 'created_at', s.created_at, 'updated_at', s.updated_at,
    'detect_products', s.detect_products,
    'catalogue', case when s.catalogue is null then null else (s.catalogue - 'sync') || jsonb_build_object('syncing', s.catalogue ? 'sync' or (s.kind = 'catalogue' and s.status in ('pending', 'crawling'))) end,
    'products', case when s.kind = 'catalogue' or s.detect_products then (select count(*) from outreach_products p where p.source_id = s.id and p.deleted_at is null) end,
    'used_by', (select count(*) from outreach_master_prompts mp where s.id = any(mp.knowledge_source_ids))
             + (select count(*) from outreach_webchat_inboxes i where i.workspace_id = s.workspace_id and i.deleted_at is null
                 and (coalesce(i.settings#>'{ai,knowledge_source_ids}', '[]'::jsonb) ? s.id::text or coalesce(i.settings#>'{ai,products,catalogue_ids}', '[]'::jsonb) ? s.id::text)))
$$;

-- Add a product catalogue: a Shopify or WooCommerce store, a product feed, or an uploaded CSV. It syncs on the next worker tick.
create or replace function outreach_hub_catalogue_add(p_ws uuid, p_provider text, p_title text default null, p_url text default null, p_storage_path text default null, p_currency text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_knowledge_sources%rowtype; u text := btrim(coalesce(p_url, '')); cur text := nullif(upper(btrim(coalesce(p_currency, ''))), ''); ttl text;
begin
  perform outreach_require(p_ws, 'manager');
  if coalesce(p_provider, '') not in ('shopify', 'woocommerce', 'feed', 'csv') then raise exception 'E_PAYLOAD_INVALID: the source is a Shopify store, a WooCommerce store, a product feed or a CSV file'; end if;
  if cur is not null and cur !~ '^[A-Z]{3}$' then raise exception 'E_PAYLOAD_INVALID: the currency is a three-letter code, like USD or INR'; end if;
  if p_provider = 'csv' then
    if coalesce(p_storage_path, '') = '' or p_storage_path not like p_ws::text || '/%' or p_storage_path like '%..%' then raise exception 'E_PAYLOAD_INVALID: upload the CSV file first'; end if;
    u := '';
  else
    if u !~* '^https?://' and u ~* '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(/.*)?$' then u := 'https://' || u; end if;
    if u !~* '^https?://[^[:space:]/?#:"<>]+\.[a-z]{2,}(:[0-9]{2,5})?([/?#][^[:space:]"<>]*)?$' or length(u) > 1000 then raise exception 'E_PAYLOAD_INVALID: enter the address of the store or the feed (https://…)'; end if;
    if p_provider = 'shopify' then u := regexp_replace(u, '^(https?://[^/?#]+).*$', '\1');
    elsif p_provider = 'woocommerce' then u := regexp_replace(regexp_replace(u, '[?#].*$', ''), '/+$', ''); end if;
  end if;
  if (select count(*) from outreach_knowledge_sources where workspace_id = p_ws) >= 50 then raise exception 'E_PAYLOAD_INVALID: up to 50 knowledge sources per workspace'; end if;
  ttl := left(coalesce(nullif(btrim(coalesce(p_title, '')), ''), nullif(regexp_replace(regexp_replace(u, '^https?://(www\.)?', '', 'i'), '[/?#].*$', ''), ''), 'Product catalogue'), 200);
  insert into outreach_knowledge_sources(workspace_id, kind, title, url, storage_path, content_type, refresh_days, created_by, catalogue)
  values (p_ws, 'catalogue', ttl, nullif(u, ''), case when p_provider = 'csv' then p_storage_path end, case when p_provider = 'csv' then 'text/csv' end,
          case when p_provider = 'csv' then null else 1 end, auth.uid(),
          jsonb_strip_nulls(jsonb_build_object('provider', p_provider, 'url', nullif(u, ''), 'currency', cur, 'currency_locked', cur is not null, 'products', 0)))
  returning * into s;
  perform outreach_audit(p_ws, 'webchat.catalogue_added', 'knowledge_source', s.id::text, jsonb_build_object('provider', p_provider, 'title', ttl, 'url', nullif(u, '')), 'user');
  return outreach__ks_json(s);
end $$;

-- Change a catalogue: {title, currency (a code, or null = take it from the source again), refresh_days (1–90, null = only on
-- "Sync now"), storage_path (a new CSV), sync: true}. On a website source: {detect_products: true | false}.
create or replace function outreach_hub_catalogue_update(p_source uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_knowledge_sources%rowtype; cur text; resync boolean := false; days int;
begin
  select * into s from outreach_knowledge_sources where id = p_source for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if s.kind = 'website' then
    if not (p_patch ? 'detect_products') or jsonb_typeof(p_patch->'detect_products') <> 'boolean' then raise exception 'E_PAYLOAD_INVALID: a website source takes detect_products (true or false)'; end if;
    if (p_patch->>'detect_products')::boolean is distinct from s.detect_products then
      s.detect_products := (p_patch->>'detect_products')::boolean;
      if s.detect_products then
        -- products are found while the pages are crawled: crawl again now
        update outreach_knowledge_sources set detect_products = true, status = 'pending', updated_at = now() where id = s.id returning * into s;
      else
        update outreach_products set deleted_at = now(), updated_at = now() where source_id = s.id and deleted_at is null;
        update outreach_knowledge_sources set detect_products = false, catalogue = null, updated_at = now() where id = s.id returning * into s;
      end if;
    end if;
    return outreach__ks_json(s);
  end if;
  if s.kind <> 'catalogue' then raise exception 'E_PAYLOAD_INVALID: not a product catalogue'; end if;
  if p_patch ? 'title' then
    if btrim(coalesce(p_patch->>'title', '')) = '' or length(p_patch->>'title') > 200 then raise exception 'E_PAYLOAD_INVALID: title 1–200 characters'; end if;
    s.title := btrim(p_patch->>'title');
  end if;
  if p_patch ? 'currency' then
    cur := nullif(upper(btrim(coalesce(p_patch->>'currency', ''))), '');
    if cur is not null and cur !~ '^[A-Z]{3}$' then raise exception 'E_PAYLOAD_INVALID: the currency is a three-letter code, like USD or INR'; end if;
    if cur is null then
      s.catalogue := s.catalogue || jsonb_build_object('currency_locked', false); resync := true;   -- the source's own currency comes back with the next sync
    else
      s.catalogue := s.catalogue || jsonb_build_object('currency', cur, 'currency_locked', true);
      update outreach_products set currency = cur, updated_at = now() where source_id = s.id and currency is distinct from cur;
    end if;
  end if;
  if p_patch ? 'refresh_days' then
    if jsonb_typeof(p_patch->'refresh_days') = 'null' then s.refresh_days := null;
    else
      if (p_patch->>'refresh_days') !~ '^[0-9]{1,2}$' or (p_patch->>'refresh_days')::int not between 1 and 90 then raise exception 'E_PAYLOAD_INVALID: refresh every 1 to 90 days'; end if;
      days := (p_patch->>'refresh_days')::int;
      if s.catalogue->>'provider' = 'csv' then raise exception 'E_PAYLOAD_INVALID: a CSV catalogue changes when you upload a new file'; end if;
      s.refresh_days := days;
    end if;
  end if;
  if p_patch ? 'storage_path' then
    if s.catalogue->>'provider' <> 'csv' then raise exception 'E_PAYLOAD_INVALID: only a CSV catalogue takes a file'; end if;
    if coalesce(p_patch->>'storage_path', '') = '' or (p_patch->>'storage_path') not like s.workspace_id::text || '/%' or (p_patch->>'storage_path') like '%..%' then raise exception 'E_PAYLOAD_INVALID: upload the CSV file first'; end if;
    s.storage_path := p_patch->>'storage_path'; resync := true;
  end if;
  if coalesce(p_patch->>'sync', '') = 'true' then resync := true; end if;
  if resync then
    if not outreach_rate_limit('catalogue:sync:' || s.id::text, 6, 3600) then raise exception 'E_RATE_LIMITED: this catalogue was synced several times in the last hour. Try again later'; end if;
    s.catalogue := s.catalogue - 'sync'; s.status := 'pending'; s.error := null;
  end if;
  update outreach_knowledge_sources set title = s.title, catalogue = s.catalogue, refresh_days = s.refresh_days, storage_path = s.storage_path, status = s.status, error = s.error, updated_at = now()
   where id = s.id returning * into s;
  return outreach__ks_json(s);
end $$;

-- The catalogue's table in the app: searchable, paged. Knowledge is workspace-level (not shown to client-scoped members).
create or replace function outreach_hub_catalogue_products(p_source uuid, p_query text default null, p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_knowledge_sources%rowtype; q text := nullif(btrim(coalesce(p_query, '')), ''); lim int := greatest(1, least(coalesce(p_limit, 50), 200)); off int := greatest(0, coalesce(p_offset, 0));
begin
  select * into s from outreach_knowledge_sources where id = p_source;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, null) then raise exception 'E_NOT_FOUND'; end if;
  if s.kind <> 'catalogue' and not s.detect_products then raise exception 'E_PAYLOAD_INVALID: not a product catalogue'; end if;
  if q is not null then q := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  return jsonb_build_object(
    'source', outreach__ks_json(s),
    'total', (select count(*) from outreach_products p where p.source_id = s.id and p.deleted_at is null
               and (q is null or p.title ilike q or p.handle ilike q or p.sku ilike q or p.product_type ilike q or p.vendor ilike q)),
    'hidden', (select count(*) from outreach_products p where p.source_id = s.id and p.deleted_at is null and p.ai_hidden),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'url', x.url, 'image', x.image_url, 'price', x.price,
                     'compare_at', case when x.compare_at_price > x.price then x.compare_at_price end, 'currency', x.currency, 'available', x.available, 'product_type', x.product_type,
                     'vendor', x.vendor, 'sku', x.sku, 'handle', x.handle, 'variants', jsonb_array_length(x.variants), 'seen_at', x.seen_at, 'ai_hidden', x.ai_hidden,
                     'pinned_keywords', to_jsonb(x.pinned_keywords)) order by x.title, x.id), '[]'::jsonb)
                   from (select p.* from outreach_products p where p.source_id = s.id and p.deleted_at is null
                          and (q is null or p.title ilike q or p.handle ilike q or p.sku ilike q or p.product_type ilike q or p.vendor ilike q)
                          order by p.title, p.id limit lim offset off) x));
end $$;

-- Hide a product from the AI, and / or pin it for a few keywords (a pinned product is boosted for questions that contain one).
create or replace function outreach_hub_product_set(p_id uuid, p_ai_hidden boolean default null, p_pinned_keywords text[] default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p outreach_products%rowtype; kw text[];
begin
  select * into p from outreach_products where id = p_id and deleted_at is null for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(p.workspace_id, 'manager');
  if p_pinned_keywords is not null then
    select coalesce(array_agg(distinct k), '{}') into kw from (select lower(btrim(x)) k from unnest(p_pinned_keywords) x) y where k <> '';
    if cardinality(kw) > 10 or exists (select 1 from unnest(kw) k where length(k) > 40) then raise exception 'E_PAYLOAD_INVALID: up to 10 keywords of 40 characters'; end if;
  end if;
  update outreach_products set ai_hidden = coalesce(p_ai_hidden, ai_hidden), pinned_keywords = coalesce(kw, pinned_keywords), updated_at = now() where id = p.id returning * into p;
  return jsonb_build_object('id', p.id, 'ai_hidden', p.ai_hidden, 'pinned_keywords', to_jsonb(p.pinned_keywords));
end $$;

-- Search products as a person: the agent's Product button in a website chat (p_inbox: that website's catalogues) and the
-- connector's catalogue_search (p_source: one catalogue; neither: every catalogue of the workspace).
create or replace function outreach_hub_product_search(p_ws uuid, p_query text default null, p_max_price numeric default null, p_source uuid default null, p_inbox uuid default null, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype; src uuid[]; flt jsonb;
begin
  perform outreach_require(p_ws, 'member');
  if p_inbox is not null then
    select * into i from outreach_webchat_inboxes where id = p_inbox and workspace_id = p_ws and deleted_at is null;
    if not found or not outreach_client_visible(p_ws, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
    src := outreach_webchat__product_sources(p_ws, outreach_webchat__settings(i.id));
  elsif not outreach_client_visible(p_ws, null) then raise exception 'E_NOT_FOUND';
  end if;
  if p_source is not null then
    if not exists (select 1 from outreach_knowledge_sources s where s.id = p_source and s.workspace_id = p_ws and (s.kind = 'catalogue' or s.detect_products)) then raise exception 'E_NOT_FOUND: catalogue'; end if;
    src := array[p_source];
  elsif src is null or cardinality(src) = 0 then
    select coalesce(array_agg(s.id), '{}') into src from outreach_knowledge_sources s where s.workspace_id = p_ws and (s.kind = 'catalogue' or s.detect_products);
  end if;
  flt := jsonb_build_object('include_oos', true, 'include_hidden', true, 'browse', true) || case when p_max_price is not null and p_max_price >= 0 then jsonb_build_object('max_price', p_max_price) else '{}'::jsonb end;
  return outreach_product__search(p_ws, src, p_query, flt, null, greatest(1, least(coalesce(p_limit, 20), 50)));
end $$;

-- Send product cards into a website chat as the agent.
--   p_suggestion null   the Product button / the connector: 1 to 6 products of the workspace, as a `cards` message
--   p_suggestion set    a Review suggestion sent with the cards the agent kept (ids out of the suggestion's own snapshot)
create or replace function outreach_hub_webchat_send_products(p_chat uuid, p_product_ids uuid[], p_text text default null, p_suggestion uuid default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; g outreach_webchat_ai_suggestions%rowtype; cards jsonb; items jsonb; n int := coalesce(cardinality(p_product_ids), 0);
        ids_t text[] := array(select u::text from unnest(p_product_ids) u);
begin
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT';
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'member');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if n < 1 or n > 6 then raise exception 'E_PAYLOAD_INVALID: pick 1 to 6 products'; end if;
  if p_suggestion is not null then
    select * into g from outreach_webchat_ai_suggestions where id = p_suggestion and chat_id = c.id;
    if not found then raise exception 'E_NOT_FOUND: suggestion'; end if;
    if btrim(coalesce(p_text, '')) = '' then raise exception 'E_PAYLOAD_INVALID: text'; end if;
    select coalesce(jsonb_agg(x.card order by array_position(ids_t, lower(x.card->>'id'))), '[]'::jsonb) into cards
      from jsonb_array_elements(g.products) x(card)
     where lower(x.card->>'id') = any(ids_t);
    if jsonb_array_length(cards) = 0 then raise exception 'E_PAYLOAD_INVALID: those products are not part of the suggestion'; end if;
    return outreach_webchat_agent_send(c.id, p_text, 'text', jsonb_build_object('products', cards, 'internal', jsonb_build_object('suggestion_id', g.id)), '[]'::jsonb, null);
  end if;
  select coalesce(jsonb_agg(outreach_product__card(p, s.catalogue->>'provider') order by array_position(p_product_ids, p.id)), '[]'::jsonb),
         -- the same cards in the shape a widget from before this file draws (title, price line, picture, a View link)
         coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('title', p.title,
             'description', case when p.price is not null then btrim(coalesce(p.currency, '') || ' ' || to_char(p.price, 'FM999,999,999,990.00')) end,
             'media_url', p.image_url, 'actions', jsonb_build_array(jsonb_build_object('type', 'link', 'text', 'View', 'uri', p.url)))) order by array_position(p_product_ids, p.id)), '[]'::jsonb)
    into cards, items
    from outreach_products p join outreach_knowledge_sources s on s.id = p.source_id
   where p.workspace_id = c.workspace_id and p.id = any(p_product_ids) and p.deleted_at is null;
  if jsonb_array_length(cards) = 0 then raise exception 'E_NOT_FOUND: products'; end if;
  return outreach_webchat_agent_send(c.id, coalesce(p_text, ''), 'cards', jsonb_build_object('items', items, 'products', cards), '[]'::jsonb, null);
end $$;

-- Attach / detach a source (063). A catalogue belongs to websites only: it is switched in the website's product settings.
create or replace function outreach_hub_knowledge_link(p_source uuid, p_kind text, p_target uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_knowledge_sources%rowtype; i outreach_webchat_inboxes%rowtype; ids jsonb; path text[];
begin
  select * into s from outreach_knowledge_sources where id = p_source;
  if not found then raise exception 'E_NOT_FOUND: knowledge source'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if p_kind = 'sequence' then
    if s.kind = 'catalogue' then raise exception 'E_PAYLOAD_INVALID: a product catalogue is used by websites, not by sequences'; end if;
    if not exists (select 1 from outreach_sequences q where q.id = p_target and q.workspace_id = s.workspace_id) then raise exception 'E_NOT_FOUND: sequence'; end if;
    if coalesce(p_on, true) then perform outreach_knowledge_attach(p_target, p_source); else perform outreach_knowledge_detach(p_target, p_source); end if;
  elsif p_kind = 'website' then
    select * into i from outreach_webchat_inboxes where id = p_target and workspace_id = s.workspace_id and deleted_at is null;
    if not found then raise exception 'E_NOT_FOUND: website'; end if;
    path := case when s.kind = 'catalogue' then array['ai', 'products', 'catalogue_ids'] else array['ai', 'knowledge_source_ids'] end;
    select coalesce(jsonb_agg(x), '[]'::jsonb) into ids from jsonb_array_elements_text(coalesce(i.settings#>path, '[]'::jsonb)) x where x <> p_source::text;
    if coalesce(p_on, true) then ids := ids || to_jsonb(p_source::text); end if;
    if ids is distinct from coalesce(i.settings#>path, '[]'::jsonb) then
      perform outreach_webchat_inbox_update(i.id, jsonb_build_object('settings', jsonb_build_object('ai',
        case when s.kind = 'catalogue' then jsonb_build_object('products', jsonb_build_object('catalogue_ids', ids)) else jsonb_build_object('knowledge_source_ids', ids) end)));
    end if;
  else raise exception 'E_PAYLOAD_INVALID: attach a source to a sequence or a website';
  end if;
  return jsonb_build_object('ok', true, 'source_id', p_source, 'kind', p_kind, 'target_id', p_target, 'on', coalesce(p_on, true));
end $$;

-- ===============================================================================================================
-- 7. Patches to existing functions (in place)
-- ===============================================================================================================
-- ---- defaults
select outreach_wbp__patch('public.outreach_webchat_default_settings()', 'campaigns_open', array[
  $a$"show_unread_count": true, "show_unread_previews": true, "hide": false, "online_dot": true,$a$,
  $b$"show_unread_count": true, "show_unread_previews": true, "hide": false, "campaigns_open": false, "online_dot": true,$b$,
  $a$"show_sources": true, "hourly_cap_per_visitor": 30, "review_timeout_min": 10$a$,
  $b$"show_sources": true, "hourly_cap_per_visitor": 30, "review_timeout_min": 10,
      "products": { "enabled": false, "catalogue_ids": [], "max": 3, "show_prices": true, "include_oos": false, "add_to_cart": false, "utm": true }$b$,
  $a$"locale": { "default": "en", "use_browser": true, "strings": {} }$a$,
  $b$"locale": { "default": "en", "use_browser": true, "strings": {} },
    "ask_buttons": [],
    "selection_ask": { "enabled": false, "area": "main, article", "label": "Ask AI" },
    "shortcut": { "enabled": null }$b$]);

-- ---- validation on save
select outreach_wbp__patch('public.outreach_webchat__settings_check(jsonb)', 'outreach_webchat__buttons_check', array[
  $a$  if vb is null or jsonb_typeof(vb) = 'null' then return; end if;$a$,
  $b$  perform outreach_webchat__buttons_check(ns);
  if vb is null or jsonb_typeof(vb) = 'null' then return; end if;$b$]);

select outreach_wbp__patch('public.outreach_webchat_inbox_update(uuid,jsonb)', 'outreach_webchat__products_fix', array[
  $a$    perform outreach_webchat__settings_check(ns);$a$,
  $b$    perform outreach_webchat__settings_check(ns);
    ns := outreach_webchat__products_fix(i.workspace_id, ns, p_patch);$b$]);

-- ---- what the widget reads
select outreach_wbp__patch('public.outreach_webchat_public_config(text,text)', 'outreach_webchat__products_public', array[
  $a$'show_sources', st#>'{ai,show_sources}'),$a$,
  $b$'show_sources', st#>'{ai,show_sources}', 'products', outreach_webchat__products_public(i.id, st)),$b$,
  $a$'continuity', jsonb_build_object('enabled', st#>'{continuity,enabled}'));$a$,
  $b$'continuity', jsonb_build_object('enabled', st#>'{continuity,enabled}'),
    'ask_buttons', coalesce((select jsonb_agg(b) from jsonb_array_elements(case when jsonb_typeof(st->'ask_buttons') = 'array' then st->'ask_buttons' else '[]'::jsonb end) b where coalesce(b->>'enabled', 'true') <> 'false'), '[]'::jsonb),
    'selection_ask', st->'selection_ask', 'shortcut', st->'shortcut');$b$]);

-- ---- a visitor message keeps what the widget's button said about it (content_attributes.internal: never sent back to the widget)
select outreach_wbp__patch('public.outreach_webchat_v_message(uuid,uuid,text,text,jsonb,text,jsonb,text)', $m$coalesce(p_attrs->'internal', '{}'::jsonb)$m$, array[
  $a$case when cardinality(flags) > 0 then jsonb_build_object('internal', jsonb_build_object('flags', to_jsonb(flags))) else '{}'::jsonb end,$a$,
  $b$case when cardinality(flags) > 0 then jsonb_build_object('internal', coalesce(p_attrs->'internal', '{}'::jsonb) || jsonb_build_object('flags', to_jsonb(flags))) else '{}'::jsonb end,$b$]);

-- ---- the assistant's context: the button's context, the product named by the page, the product settings, and what
-- the visitor was last shopping for in this conversation (a short follow-up like "a red one?" builds on it)
select outreach_wbp__patch('public.outreach_webchat_v_ai_context(uuid,uuid)', 'outreach_webchat__products_ctx', array[
  $a$'qa', outreach_knowledge_qa_for(c.workspace_id, 'website', i.id, q.text));$a$,
  $b$'qa', outreach_knowledge_qa_for(c.workspace_id, 'website', i.id, q.text),
    'context', q.content_attributes#>>'{internal,context}', 'product_ref', q.content_attributes#>>'{internal,product}',
    'products', outreach_webchat__products_ctx(i.id, st),
    'last_product_search', (select t.product_search from outreach_webchat_ai_turns t
                             where t.chat_id = c.id and t.created_at > now() - interval '30 minutes' and t.product_search is not null
                               and (coalesce(t.product_search->>'shopping', '') = 'true' or jsonb_array_length(t.products) > 0)
                             order by t.created_at desc limit 1));$b$]);

select outreach_wbp__patch('public.outreach_webchat_v_suggest_context(uuid)', 'outreach_webchat__products_ctx', array[
  $a$'qa', outreach_knowledge_qa_for(c.workspace_id, 'website', i.id, q.text));$a$,
  $b$'qa', outreach_knowledge_qa_for(c.workspace_id, 'website', i.id, q.text),
    'context', q.content_attributes#>>'{internal,context}', 'product_ref', q.content_attributes#>>'{internal,product}',
    'products', outreach_webchat__products_ctx(i.id, st));$b$]);

-- ---- the answer carries its cards; the turn remembers them
select outreach_wbp__patch('public.outreach_webchat_v_ai_record(uuid,uuid,jsonb)', 'product_search', array[
  $a$jsonb_build_object('ai', true, 'sources', coalesce(p_turn->'sources', '[]'::jsonb), 'confidence', p_turn->>'confidence'));$a$,
  $b$jsonb_build_object('ai', true, 'sources', coalesce(p_turn->'sources', '[]'::jsonb), 'confidence', p_turn->>'confidence')
           || case when jsonb_typeof(p_turn->'products') = 'array' and jsonb_array_length(p_turn->'products') > 0 then jsonb_build_object('products', p_turn->'products') else '{}'::jsonb end);$b$,
  $a$  returning id into tid;$a$,
  $b$  returning id into tid;
  update outreach_webchat_ai_turns
     set products = coalesce((select jsonb_agg(x->'id') from jsonb_array_elements(case when jsonb_typeof(p_turn->'products') = 'array' then p_turn->'products' else '[]'::jsonb end) x where x->>'id' is not null), '[]'::jsonb),
         context = nullif(left(coalesce(p_turn->>'context', ''), 700), ''),
         product_id = (select p.id from outreach_products p where p.id::text = p_turn->>'product_id' and p.workspace_id = c.workspace_id),
         product_search = case when jsonb_typeof(p_turn->'product_search') = 'object' then p_turn->'product_search' end
   where id = tid;$b$]);

select outreach_wbp__patch('public.outreach_webchat_v_suggest_record(uuid,jsonb)', $m$products = case when jsonb_typeof(p_turn->'products')$m$, array[
  $a$set text = left(ans, 20000), sources = coalesce(p_turn->'sources', '[]'::jsonb),$a$,
  $b$set text = left(ans, 20000), sources = coalesce(p_turn->'sources', '[]'::jsonb), products = case when jsonb_typeof(p_turn->'products') = 'array' then p_turn->'products' else '[]'::jsonb end,$b$]);

-- ---- the website report gets its Products block
select outreach_wbp__patch('public.outreach_webchat_report(uuid,uuid,date,date)', 'outreach_webchat__products_report', array[
  $a$      'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', n) order by d), '[]'::jsonb)$a$,
  $b$      'products', outreach_webchat__products_report(p_ws, p_inbox, f, t),
      'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', n) order by d), '[]'::jsonb)$b$]);

-- ---- knowledge: a catalogue is not a sequence's knowledge; removing one takes it off the websites; "used in" lists them
select outreach_wbp__patch('public.outreach_knowledge_attach(uuid,uuid)', 'a product catalogue is used by websites', array[
  $a$  if not found then raise exception 'E_NOT_FOUND: knowledge source'; end if;$a$,
  $b$  if not found then raise exception 'E_NOT_FOUND: knowledge source'; end if;
  if s.kind = 'catalogue' then raise exception 'E_PAYLOAD_INVALID: a product catalogue is used by websites, not by sequences'; end if;$b$]);

select outreach_wbp__patch('public.outreach_knowledge_source_delete(uuid)', '{ai,products,catalogue_ids}', array[
  $a$  delete from outreach_knowledge_sources where id = p_id;$a$,
  $b$  update outreach_webchat_inboxes i
     set settings = jsonb_set(i.settings, '{ai,products,catalogue_ids}', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements_text(i.settings#>'{ai,products,catalogue_ids}') x where x <> p_id::text)),
         config_version = i.config_version + 1
   where i.workspace_id = s.workspace_id and jsonb_typeof(i.settings#>'{ai,products,catalogue_ids}') = 'array' and (i.settings#>'{ai,products,catalogue_ids}') ? p_id::text;
  delete from outreach_knowledge_sources where id = p_id;$b$]);

select outreach_wbp__patch('public.outreach_hub_knowledge(uuid)', '{ai,products,catalogue_ids}', array[
  $a$where i.workspace_id = p_ws and i.deleted_at is null and coalesce(i.settings#>'{ai,knowledge_source_ids}', '[]'::jsonb) ? s.id::text and outreach_client_visible(p_ws, i.client_id)) u))$a$,
  $b$where i.workspace_id = p_ws and i.deleted_at is null and (coalesce(i.settings#>'{ai,knowledge_source_ids}', '[]'::jsonb) ? s.id::text or coalesce(i.settings#>'{ai,products,catalogue_ids}', '[]'::jsonb) ? s.id::text) and outreach_client_visible(p_ws, i.client_id)) u))$b$]);

-- ===============================================================================================================
-- 8. Grants
-- ===============================================================================================================
do $$
declare f record;
  app_fns text[] := array[
    'outreach_hub_catalogue_add', 'outreach_hub_catalogue_update', 'outreach_hub_catalogue_products', 'outreach_hub_product_set', 'outreach_hub_product_search',
    'outreach_hub_webchat_send_products', 'outreach_hub_knowledge_link'];
  svc_fns text[] := array[
    'outreach_product__num', 'outreach_product__tsv', 'outreach_product__url_key', 'outreach_product__card', 'outreach_product__search', 'outreach_product_search',
    'outreach_product__resolve', 'outreach_product_resolve', 'outreach_product_get', 'outreach_knowledge_claim', 'outreach_catalogue_begin', 'outreach_catalogue_progress',
    'outreach_catalogue_upsert', 'outreach_catalogue_finish', 'outreach_webchat__url_rules_check', 'outreach_webchat__buttons_check', 'outreach_webchat__product_sources',
    'outreach_webchat__add_to_cart_ok', 'outreach_webchat__products_public', 'outreach_webchat__products_ctx', 'outreach_webchat__products_fix', 'outreach_webchat__products_report'];
begin
  for f in select p.oid::regprocedure::text as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname = any(app_fns) or p.proname = any(svc_fns)) loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname = any(app_fns) then execute format('grant execute on function %s to authenticated', f.sig);
    else execute format('revoke all on function %s from authenticated', f.sig); end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

drop function if exists outreach_wbp__patch(text, text, text[]);
