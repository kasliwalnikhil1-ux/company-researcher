-- Smoke test — 068 web chat: own buttons, Ask AI buttons, product catalogue and recommendations. Builds fixtures, asserts,
-- then RAISES so everything rolls back. A passing run ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_18_webchat_buttons_products.sql
-- Service functions run as the superuser here (outreach_is_service() is true); user RPCs impersonate members.
do $$
declare
  log text := ''; fails int := 0; j jsonb; k jsonb; t text; n int; i int; b boolean; bad jsonb; started timestamptz; x record;
  ws uuid; u_owner uuid; u_member uuid; ib uuid; tok text; cat uuid; cat2 uuid; web uuid; seq uuid;
  p_choker uuid; p_ear uuid; p_kundan uuid; p_oos uuid; p_ring uuid; vis uuid; chat uuid; msg uuid; sg uuid; mid uuid; batch jsonb;
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at, user_id limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at, user_id limit 1 offset 1;
  if u_member is null then raise exception 'SMOKE FAIL: this test needs two active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke16', 'smoke16-' || encode(gen_random_bytes(4),'hex'), u_owner, 'scale') returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner16@test.local', 'Aarushi');
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_member, 'member', 'member16@test.local', 'Naman');

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_inbox_create(ws, 'Aurum Jewels', array['aurum.shop'], null);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  ib := (j->>'id')::uuid; tok := j->>'website_token';

  -- ============================================================ 1. defaults
  if (j#>>'{settings,launcher,hide}') = 'false' and (j#>>'{settings,launcher,campaigns_open}') = 'false' and (j#>'{settings,ask_buttons}') = '[]'::jsonb
     and (j#>>'{settings,selection_ask,enabled}') = 'false' and (j#>>'{settings,selection_ask,area}') = 'main, article' and (j#>>'{settings,selection_ask,label}') = 'Ask AI'
     and (j#>'{settings,shortcut}') ? 'enabled' and jsonb_typeof(j#>'{settings,shortcut,enabled}') = 'null'
     and (j#>'{settings,ai,products}') = '{"enabled": false, "catalogue_ids": [], "max": 3, "show_prices": true, "include_oos": false, "add_to_cart": false, "utm": true}'::jsonb
     and (j#>>'{settings,launcher,video,shape}') = 'circle' and (j#>>'{settings,ai,review_timeout_min}') = '10'
    then log := log || E'\nok   defaults: our launcher, campaigns do not open the chat, no buttons, selection off, shortcut follows the shell, recommendations off';
    else fails := fails + 1; log := log || E'\nFAIL defaults: ' || left((j->'settings'->'launcher')::text, 200) || ' / ' || coalesce((j#>'{settings,ai,products}')::text, 'null') || ' / ' || coalesce((j#>'{settings,shortcut}')::text, 'null'); end if;

  -- ============================================================ 2. own buttons + Ask AI buttons: save, public config
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_inbox_update(ib, '{"settings":{"launcher":{"hide":true,"campaigns_open":true},
        "ask_buttons":[{"id":"hdr1","kind":"header","selector":"header nav, header","position":"end","label":"Ask AI","style":"filled","icon":true,"click":"open","mode":"sidebar","url_rules":[],"enabled":true},
                       {"id":"pdp1","kind":"element","selector":".product-form","position":"after","label":"Ask about this product","style":"match","icon":false,"click":"ask","text":"Is this good for a wedding?","context":"product","url_rules":[{"op":"contains","value":"/products/","action":"show"}],"enabled":true},
                       {"id":"off1","kind":"element","selector":".x","position":"inside","click":"prefill","text":"A quote for ","enabled":false}],
        "selection_ask":{"enabled":true,"area":"main","label":"Ask"},"shortcut":{"enabled":true}}}'::jsonb);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  k := outreach_webchat_public_config(tok, 'https://aurum.shop');
  if jsonb_array_length(j#>'{settings,ask_buttons}') = 3 and (k#>>'{settings,launcher,hide}') = 'true' and (k#>>'{settings,launcher,campaigns_open}') = 'true'
     and jsonb_array_length(k#>'{settings,ask_buttons}') = 2 and (k#>>'{settings,ask_buttons,1,context}') = 'product' and (k#>>'{settings,ask_buttons,0,mode}') = 'sidebar'
     and (k#>>'{settings,selection_ask,area}') = 'main' and (k#>>'{settings,shortcut,enabled}') = 'true'
     and (k#>'{settings,ai,products}') = '{"enabled": false, "show_prices": true, "add_to_cart": false, "utm": true}'::jsonb
     and not ((k#>'{settings,ai}') ? 'knowledge_source_ids') and (k#>>'{settings,appearance,mode}') = 'bubble'
    then log := log || E'\nok   save + public_config: own-buttons mode, the two enabled buttons, selection, shortcut; products as four public flags, never the ids';
    else fails := fails + 1; log := log || E'\nFAIL save/public: ' || left(coalesce(k->'settings'->'ask_buttons', 'null'::jsonb)::text, 300) || ' / ' || coalesce((k#>'{settings,ai}')::text, 'null'); end if;

  -- ============================================================ 3. validation: every bad value is refused
  n := 0; t := '';
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  for bad in select * from jsonb_array_elements('[
      {"launcher":{"campaigns_open":"yes"}},
      {"ask_buttons":{"id":"a"}},
      {"ask_buttons":[{"id":"a","kind":"header","selector":"h"},{"id":"b","kind":"header","selector":"h"},{"id":"c","kind":"header","selector":"h"},{"id":"d","kind":"header","selector":"h"},{"id":"e","kind":"header","selector":"h"},{"id":"f","kind":"header","selector":"h"},{"id":"g","kind":"header","selector":"h"},{"id":"h","kind":"header","selector":"h"},{"id":"i","kind":"header","selector":"h"},{"id":"j","kind":"header","selector":"h"},{"id":"k","kind":"header","selector":"h"}]},
      {"ask_buttons":[{"id":"a","kind":"header","selector":"h"},{"id":"a","kind":"header","selector":"h"}]},
      {"ask_buttons":[{"id":"A b","kind":"header","selector":"h"}]},
      {"ask_buttons":[{"id":"a","kind":"footer","selector":"h"}]},
      {"ask_buttons":[{"id":"a","kind":"element"}]},
      {"ask_buttons":[{"id":"a","kind":"element","selector":"div{x}"}]},
      {"ask_buttons":[{"id":"a","kind":"element","selector":"<script>"}]},
      {"ask_buttons":[{"id":"a","kind":"header","selector":"h","position":"after"}]},
      {"ask_buttons":[{"id":"a","kind":"element","selector":"h","position":"start"}]},
      {"ask_buttons":[{"id":"a","kind":"header","selector":"h","label":"0123456789012345678901234567890"}]},
      {"ask_buttons":[{"id":"a","kind":"header","selector":"h","style":"neon"}]},
      {"ask_buttons":[{"id":"a","kind":"header","selector":"h","icon":"yes"}]},
      {"ask_buttons":[{"id":"a","kind":"header","selector":"h","click":"ask","text":"Hi"}]},
      {"ask_buttons":[{"id":"a","kind":"element","selector":"h","click":"ask"}]},
      {"ask_buttons":[{"id":"a","kind":"element","selector":"h","click":"run"}]},
      {"ask_buttons":[{"id":"a","kind":"element","selector":"h","context":"cart"}]},
      {"ask_buttons":[{"id":"a","kind":"element","selector":"h","mode":"embedded"}]},
      {"ask_buttons":[{"id":"a","kind":"element","selector":"h","url_rules":[{"op":"like","value":"/x","action":"show"}]}]},
      {"ask_buttons":[{"id":"a","kind":"element","selector":"h","url_rules":[{"op":"contains","value":"/x","action":"maybe"}]}]},
      {"ask_buttons":[{"id":"a","kind":"element","selector":"h","onclick":"alert(1)"}]},
      {"selection_ask":{"enabled":"on"}},
      {"selection_ask":{"label":"0123456789012345678901234567890"}},
      {"selection_ask":{"area":"main{}"}},
      {"shortcut":{"enabled":"yes"}},
      {"ai":{"products":{"max":7}}},
      {"ai":{"products":{"max":"3"}}},
      {"ai":{"products":{"show_prices":"no"}}},
      {"ai":{"products":{"catalogue_ids":["not-a-uuid"]}}},
      {"ai":{"products":{"enabled":true}}}
    ]'::jsonb) loop
    begin
      perform outreach_webchat_inbox_update(ib, jsonb_build_object('settings', bad));
      t := t || ' accepted:' || left(bad::text, 90);
    exception when others then
      if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; else t := t || ' other:' || left(sqlerrm, 80); end if;
    end;
  end loop;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if n = 31 and t = '' and jsonb_array_length((select settings->'ask_buttons' from outreach_webchat_inboxes where id = ib)) = 3
    then log := log || E'\nok   validation: 31 bad settings refused (limits, enums, unknown fields, markup in selectors, recommending without a catalogue); nothing stored';
    else fails := fails + 1; log := log || E'\nFAIL validation: ' || n || '/31' || t; end if;

  -- ============================================================ 4. catalogues: add (manager only), list, not for sequences
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_hub_catalogue_add(ws, 'shopify', null, 'https://aurum.shop'); t := 'no error'; exception when others then t := sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_hub_catalogue_add(ws, 'shopify', null, 'aurum.shop/collections/all?x=1');
  k := outreach_hub_catalogue_add(ws, 'feed', 'Merchant feed', 'https://cdn.aurum.shop/feed.xml', null, 'inr');
  cat := (j->>'id')::uuid; cat2 := (k->>'id')::uuid;
  n := 0;
  begin perform outreach_hub_catalogue_add(ws, 'magento', null, 'https://x.shop'); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  begin perform outreach_hub_catalogue_add(ws, 'feed', null, 'javascript:alert(1)'); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  begin perform outreach_hub_catalogue_add(ws, 'csv', null, null, 'someone-else/file.csv'); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  begin perform outreach_hub_catalogue_add(ws, 'feed', null, 'https://x.shop/f.xml', null, 'rupees'); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  insert into outreach_sequences(workspace_id, name, created_by) values (ws, 'Seq 16', u_owner) returning id into seq;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_hub_knowledge_link(cat, 'sequence', seq, true); b := false; exception when others then b := sqlerrm like 'E_PAYLOAD_INVALID%'; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_FORBIDDEN%' and j->>'kind' = 'catalogue' and j->>'status' = 'pending' and j->>'title' = 'aurum.shop' and j->>'url' = 'https://aurum.shop' and (j->>'refresh_days')::int = 1
     and j#>>'{catalogue,provider}' = 'shopify' and (j#>>'{catalogue,syncing}')::boolean and (j->>'products')::int = 0
     and k#>>'{catalogue,currency}' = 'INR' and (k#>>'{catalogue,currency_locked}')::boolean and n = 4 and b
    then log := log || E'\nok   catalogue_add: managers only, the store address is cut to its origin, daily refresh, currency override; bad provider / link / path / currency refused; not attachable to a sequence';
    else fails := fails + 1; log := log || E'\nFAIL catalogue_add: ' || t || ' n=' || n || ' b=' || coalesce(b::text, 'null') || ' ' || left(j::text, 300); end if;

  -- ============================================================ 5. sync: claim, begin, upsert in batches, finish
  update outreach_knowledge_sources set updated_at = now() - interval '1 hour' where id in (cat, cat2);
  select count(*) into n from outreach_knowledge_claim(10) c where c.id in (cat, cat2);
  j := outreach_catalogue_begin(cat); started := (j->>'started_at')::timestamptz;
  k := outreach_catalogue_begin(cat);   -- a second run picks up the same sync
  batch := jsonb_build_array(
    jsonb_build_object('external_id', '101', 'handle', 'polki-choker-set', 'sku', 'PCS-1', 'url', 'https://aurum.shop/products/polki-choker-set', 'title', 'Polki Choker Set',
      'description', 'Uncut diamond choker with matching earrings.', 'vendor', 'Aurum', 'product_type', 'Necklace', 'tags', jsonb_build_array('bridal', 'polki'), 'options', jsonb_build_object('Finish', jsonb_build_array('Gold', 'Rose gold')),
      'price', 45000, 'compare_at_price', 52000, 'available', true, 'image_url', 'https://cdn.aurum.shop/polki.jpg', 'images', jsonb_build_array('https://cdn.aurum.shop/polki.jpg', 'javascript:x'),
      'variants', jsonb_build_array(jsonb_build_object('id', '9001', 'title', 'Gold', 'price', 45000, 'available', false, 'sku', 'PCS-1-G'), jsonb_build_object('id', '9002', 'title', 'Rose gold', 'price', 45000, 'available', true, 'sku', 'PCS-1-R'))),
    jsonb_build_object('external_id', '102', 'handle', 'jadau-earrings', 'url', 'https://aurum.shop/products/jadau-earrings', 'title', 'Jadau Earrings', 'product_type', 'Earrings', 'tags', jsonb_build_array('bridal', 'jadau'),
      'price', 18500, 'available', true, 'image_url', 'https://cdn.aurum.shop/jadau.jpg', 'variants', jsonb_build_array(jsonb_build_object('id', '9003', 'price', 18500, 'available', true))),
    jsonb_build_object('external_id', '103', 'handle', 'kundan-necklace', 'url', 'https://aurum.shop/products/kundan-necklace', 'title', 'Kundan Necklace Set', 'product_type', 'Necklace', 'tags', jsonb_build_array('kundan', 'festive'),
      'price', 96000, 'available', true, 'variants', jsonb_build_array(jsonb_build_object('id', '9004', 'price', 96000, 'available', true))),
    jsonb_build_object('external_id', '104', 'handle', 'polki-necklace-royal', 'url', 'https://aurum.shop/products/polki-necklace-royal', 'title', 'Royal Polki Necklace', 'product_type', 'Necklace', 'tags', jsonb_build_array('polki'),
      'price', 240000, 'available', false),
    jsonb_build_object('external_id', '105', 'handle', 'solitaire-ring', 'url', 'https://aurum.shop/products/solitaire-ring', 'title', 'Solitaire Ring', 'product_type', 'Ring', 'tags', jsonb_build_array('bridal'), 'price', 30000, 'available', true),
    jsonb_build_object('external_id', '105', 'url', 'https://aurum.shop/products/solitaire-ring', 'title', 'Solitaire Ring (duplicate row)', 'price', 1),
    jsonb_build_object('external_id', '', 'url', 'https://aurum.shop/products/none', 'title', 'No id'),
    jsonb_build_object('external_id', '106', 'url', 'ftp://aurum.shop/x', 'title', 'Bad link'));
  j := outreach_catalogue_upsert(cat, batch, started);
  k := outreach_catalogue_finish(cat, started, true, jsonb_build_object('currency', 'inr', 'store', 'https://aurum.shop', 'pages', 1));
  select id into p_choker from outreach_products where source_id = cat and external_id = '101';
  select id into p_ear    from outreach_products where source_id = cat and external_id = '102';
  select id into p_kundan from outreach_products where source_id = cat and external_id = '103';
  select id into p_oos    from outreach_products where source_id = cat and external_id = '104';
  select id into p_ring   from outreach_products where source_id = cat and external_id = '105';
  if n = 2 and (outreach_catalogue_begin(cat)->>'started_at') is not null and (j->>'received')::int = 5 and (j->>'upserted')::int = 5 and (k->>'products')::int = 5
     and (select status from outreach_knowledge_sources where id = cat) = 'ready' and (select catalogue->>'currency' from outreach_knowledge_sources where id = cat) = 'INR'
     and (select catalogue->>'store' from outreach_knowledge_sources where id = cat) = 'https://aurum.shop'
     and (select count(*) from outreach_products where source_id = cat and currency = 'INR') = 5
     and (select title from outreach_products where id = p_ring) = 'Solitaire Ring'
     and (select images from outreach_products where id = p_choker) = array['https://cdn.aurum.shop/polki.jpg']
     and (select search @@ to_tsquery('simple', 'rose') from outreach_products where id = p_choker)
    then log := log || E'\nok   sync: both catalogues claimed, a running sync is resumed, 5 products in (duplicate, no-id and bad-link rows dropped), currency and store learnt at the end, option values searchable';
    else fails := fails + 1; log := log || E'\nFAIL sync: claimed=' || n || ' ' || coalesce(j::text, 'null') || ' ' || coalesce(k::text, 'null') || ' ' || (select coalesce(catalogue::text, 'null') from outreach_knowledge_sources where id = cat); end if;
  update outreach_knowledge_sources set catalogue = catalogue - 'sync' where id = cat;   -- the begin() in the check above opened a sync

  -- ============================================================ 6. search: price, plural, stock, hidden, pin
  j := outreach_product_search(ws, array[cat], 'show me polki necklaces', '{"max_price": 100000}'::jsonb, null, 12);
  k := outreach_product_search(ws, array[cat], 'polki necklaces', '{"include_oos": true}'::jsonb, null, 12);
  if jsonb_array_length(j) = 2 and j#>>'{0,id}' = p_choker::text and j#>>'{1,id}' = p_kundan::text
     and not exists (select 1 from jsonb_array_elements(j) c where (c->>'price')::numeric > 100000)
     and j#>>'{0,variant_id}' = '9002' and (j#>>'{0,compare_at}')::numeric = 52000 and j#>>'{0,currency}' = 'INR' and j#>>'{0,image}' = 'https://cdn.aurum.shop/polki.jpg'
     and exists (select 1 from jsonb_array_elements(k) c where c->>'id' = p_oos::text) and not exists (select 1 from jsonb_array_elements(j) c where c->>'id' = p_oos::text)
    then log := log || E'\nok   search: "polki necklaces" under 1 lakh → the choker first, all within budget, plural matched, out-of-stock only when included, card = catalogue data with the first buyable variant';
    else fails := fails + 1; log := log || E'\nFAIL search: ' || left(j::text, 500); end if;

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_hub_product_set(p_kundan, true, null); t := 'no error'; exception when others then t := sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  perform outreach_hub_product_set(p_kundan, true, null);
  j := outreach_hub_product_set(p_ring, null, array[' Gift ', 'anniversary', 'gift']);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  k := outreach_product_search(ws, array[cat], 'necklace', '{}'::jsonb, null, 12);
  if t like 'E_FORBIDDEN%' and (j->'pinned_keywords') = '["anniversary", "gift"]'::jsonb
     and not exists (select 1 from jsonb_array_elements(k) c where c->>'id' = p_kundan::text) and jsonb_array_length(k) = 1
     and (outreach_product_search(ws, array[cat], 'a gift for my wife', '{}'::jsonb, null, 12))#>>'{0,id}' = p_ring::text
     and outreach_product_search(ws, array[cat], 'what is your return policy', '{}'::jsonb, null, 12) = '[]'::jsonb
     and jsonb_array_length(outreach_product_search(ws, array[cat], 'anything under 20000?', '{"max_price": 20000}'::jsonb, null, 12)) = 1
     and outreach_product_search(ws, array[cat2], 'necklace', '{}'::jsonb, null, 12) = '[]'::jsonb
    then log := log || E'\nok   hide + pin: managers only; a hidden product is never offered; a pinned keyword brings its product up; a policy question finds nothing; a budget alone lists what fits; other catalogues stay out';
    else fails := fails + 1; log := log || E'\nFAIL hide/pin: ' || t || ' ' || left(coalesce(k::text, 'null'), 300); end if;

  -- ============================================================ 7. the current product: resolve, similar, cheaper, what goes with it
  if outreach_product_resolve(ws, array[cat], 'product:polki-choker-set') = p_choker and outreach_product_resolve(ws, array[cat], 'product:PCS-1-R') = p_choker
     and outreach_product_resolve(ws, array[cat], 'https://www.aurum.shop/collections/bridal/products/polki-choker-set/?variant=9002#reviews') = p_choker
     and outreach_product_resolve(ws, array[cat], 'https://aurum.shop/products/jadau-earrings') = p_ear
     and outreach_product_resolve(ws, array[cat], 'https://aurum-preview.myshopify.com/products/jadau-earrings') = p_ear
     and outreach_product_resolve(ws, array[cat], 'product:' || p_ring::text) = p_ring and outreach_product_resolve(ws, array[cat], 'Jadau Earrings') = p_ear
     and outreach_product_resolve(ws, array[cat], 'https://aurum.shop/pages/about') is null and outreach_product_resolve(ws, array[cat2], 'product:polki-choker-set') is null
    then log := log || E'\nok   resolve: handle, variant SKU, page URL (www, collection path, query, trailing slash), the same handle on another domain, id, title; other pages and other catalogues → nothing';
    else fails := fails + 1; log := log || E'\nFAIL resolve'; end if;

  update outreach_products set ai_hidden = false where id = p_kundan;
  j := outreach_product_search(ws, array[cat], 'anything similar but cheaper?', jsonb_build_object('lt_price', 96000), p_kundan, 12);
  k := outreach_product_search(ws, array[cat], 'what goes with this?', '{"complement": true}'::jsonb, p_choker, 12);
  if jsonb_array_length(j) = 1 and j#>>'{0,id}' = p_choker::text
     and jsonb_array_length(k) = 2 and not exists (select 1 from jsonb_array_elements(k) c where c->>'product_type' = 'Necklace' or c->>'id' = p_choker::text)
     and (outreach_product_search(ws, array[cat], 'polki', '{}'::jsonb, p_choker, 12)) = '[]'::jsonb is not true
     and not exists (select 1 from jsonb_array_elements(outreach_product_search(ws, array[cat], 'necklace', '{}'::jsonb, p_choker, 12)) c where c->>'id' = p_choker::text)
    then log := log || E'\nok   current product: "similar but cheaper" → the same type below its price; "what goes with this" → other types sharing a tag; the product itself is never suggested';
    else fails := fails + 1; log := log || E'\nFAIL current product: ' || left(j::text, 300) || ' / ' || left(k::text, 300); end if;

  -- ============================================================ 8. recommending is switched on per website; Add to cart needs the store's own domain
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_webchat_inbox_update(ib, jsonb_build_object('settings', jsonb_build_object('ai', jsonb_build_object('products', jsonb_build_object('enabled', true, 'catalogue_ids', jsonb_build_array(cat2))))));
    t := 'no error'; exception when others then t := sqlerrm; end;   -- the feed has no products yet
  j := outreach_webchat_inbox_update(ib, jsonb_build_object('ai_enabled', true, 'settings', jsonb_build_object('ai', jsonb_build_object('mode', 'first',
         'products', jsonb_build_object('enabled', true, 'catalogue_ids', jsonb_build_array(cat, gen_random_uuid()), 'max', 2, 'add_to_cart', true)))));
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  k := outreach_webchat_public_config(tok, 'https://aurum.shop');
  if t like 'E_PAYLOAD_INVALID%' and (j#>'{settings,ai,products,catalogue_ids}') = jsonb_build_array(cat) and (j#>>'{settings,ai,products,enabled}') = 'true'
     and (k#>'{settings,ai,products}') = '{"enabled": true, "show_prices": true, "add_to_cart": true, "utm": true}'::jsonb
     and (outreach_webchat__products_ctx(ib, outreach_webchat__settings(ib))->'sources') = jsonb_build_array(cat)
     and (outreach_webchat__products_ctx(ib, outreach_webchat__settings(ib))->>'max')::int = 2 and outreach_webchat__products_ctx(ib, outreach_webchat__settings(ib))->>'currency' = 'INR'
    then log := log || E'\nok   recommend: refused while the picked catalogue is empty; unknown ids dropped; Add to cart offered because the Shopify store is an allowed domain';
    else fails := fails + 1; log := log || E'\nFAIL recommend: ' || t || ' ' || coalesce((k#>'{settings,ai,products}')::text, 'null') || ' ' || coalesce((j#>'{settings,ai,products}')::text, 'null'); end if;
  update outreach_knowledge_sources set catalogue = catalogue || '{"store": "https://other-store.com", "url": "https://other-store.com"}'::jsonb where id = cat;
  b := (outreach_webchat_public_config(tok, 'https://aurum.shop')#>>'{settings,ai,products,add_to_cart}')::boolean;
  update outreach_knowledge_sources set catalogue = catalogue || '{"store": "https://aurum.shop", "url": "https://aurum.shop"}'::jsonb where id = cat;
  if b = false then log := log || E'\nok   Add to cart is not offered for a store on another domain';
  else fails := fails + 1; log := log || E'\nFAIL add_to_cart on a foreign store domain'; end if;

  -- ============================================================ 9. a question from a button: context on the message, cards on the answer
  j := outreach_webchat_v_visitor(ib, null, null, '{}'::jsonb); vis := (j->'visitor'->>'id')::uuid;
  j := outreach_webchat_v_conversation_start(ib, vis, null, 'element_button', jsonb_build_object('url', 'https://aurum.shop/products/polki-choker-set', 'title', 'Polki Choker Set'));
  chat := (j->'conversation'->>'id')::uuid;
  j := outreach_webchat_v_message(vis, chat, 'e16-1', 'Is this good for a wedding? http://a.b http://a.c http://a.d http://a.e http://a.f http://a.g', '[]'::jsonb, 'text',
         jsonb_build_object('internal', jsonb_build_object('context', 'product:polki-choker-set', 'product', 'https://aurum.shop/products/polki-choker-set')), 'widget');
  msg := (j->'message'->>'id')::uuid;
  k := outreach_webchat_v_ai_context(chat, msg);
  if (j->>'ai')::boolean and (select source from outreach_chats where id = chat) = 'element_button' and not ((j->'message'->'content_attributes') ? 'internal')
     and (select content_attributes#>>'{internal,context}' from outreach_messages where id = msg) = 'product:polki-choker-set'
     and (select content_attributes#>'{internal,flags}' from outreach_messages where id = msg) = '["link_spam"]'::jsonb
     and (k->>'ok')::boolean and k->>'context' = 'product:polki-choker-set' and k->>'product_ref' = 'https://aurum.shop/products/polki-choker-set'
     and (k#>'{products,sources}') = jsonb_build_array(cat) and (k#>>'{products,add_to_cart}')::boolean
    then log := log || E'\nok   message: the button''s context is kept on the message (next to the spam flag), never shown back to the widget, and reaches the assistant with the product settings';
    else fails := fails + 1; log := log || E'\nFAIL message context: ' || left(coalesce(k::text, 'null'), 400); end if;

  batch := (select jsonb_agg(c - 'score' - 'description' - 'tags' - 'product_type' - 'vendor' - 'source_id' - 'ai_hidden') from jsonb_array_elements(outreach_product_search(ws, array[cat], 'jadau earrings ring', '{}'::jsonb, p_choker, 2)) c);
  j := outreach_webchat_v_ai_record(chat, msg, jsonb_build_object('query', 'Is this good for a wedding?', 'answer', 'Yes. The Jadau Earrings go well with it.', 'sources', '[]'::jsonb, 'confidence', 'high', 'model', 'test',
         'tokens_in', 10, 'tokens_out', 5, 'latency_ms', 100, 'products', batch, 'context', 'product:polki-choker-set', 'product_id', p_choker,
         'product_search', jsonb_build_object('q', 'jadau earrings ring', 'found', 2, 'shopping', true)));
  mid := (j->'message'->>'id')::uuid;
  select * into x from outreach_webchat_ai_turns where id = (j->>'turn_id')::uuid;
  if jsonb_array_length(batch) = 2 and jsonb_array_length(j#>'{message,content_attributes,products}') = 2
     and (j#>'{message,content_attributes,products,0}') ?& array['id', 'title', 'price', 'currency', 'url', 'available'] and not ((j#>'{message,content_attributes,products,0}') ? 'score')
     and x.products = (select jsonb_agg(c->'id') from jsonb_array_elements(batch) c) and x.context = 'product:polki-choker-set' and x.product_id = p_choker and (x.product_search->>'found')::int = 2
     and (select jsonb_array_length(content_attributes->'products') from outreach_messages where id = mid) = 2
    then log := log || E'\nok   ai_record: the answer message carries the card snapshots, the turn the ids, the context and the product looked at';
    else fails := fails + 1; log := log || E'\nFAIL ai_record: ' || left(coalesce(j::text, 'null'), 400); end if;

  -- a follow-up in the same conversation is told what the visitor was last shopping for
  j := outreach_webchat_v_message(vis, chat, 'e16-1b', 'a red one?', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  k := outreach_webchat_v_ai_context(chat, (j->'message'->>'id')::uuid);
  if k#>>'{last_product_search,q}' = 'jadau earrings ring' and k->>'context' is null
    then log := log || E'\nok   follow-up: the assistant''s context carries the conversation''s last product search (and no stale button context)';
    else fails := fails + 1; log := log || E'\nFAIL follow-up context: ' || coalesce((k->'last_product_search')::text, 'null'); end if;

  -- ============================================================ 10. Review mode: the suggestion keeps the cards; the agent sends the ones kept
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  perform outreach_hub_website_set_mode(ib, 'review', null, 5);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  j := outreach_webchat_v_visitor(ib, null, null, '{}'::jsonb); vis := (j->'visitor'->>'id')::uuid;
  j := outreach_webchat_v_conversation_start(ib, vis, null, 'ask', null); chat := (j->'conversation'->>'id')::uuid;
  j := outreach_webchat_v_message(vis, chat, 'e16-2', 'Show me bridal pieces', '[]'::jsonb, 'text', jsonb_build_object('internal', jsonb_build_object('context', 'Page: Bridal edit')), 'widget');
  sg := (j->>'suggest')::uuid;
  perform outreach_webchat_v_suggest_take(sg);
  k := outreach_webchat_v_suggest_context(sg);
  batch := (select jsonb_agg(c - 'score' - 'description' - 'tags' - 'product_type' - 'vendor' - 'source_id' - 'ai_hidden') from jsonb_array_elements(outreach_product_search(ws, array[cat], 'bridal', '{}'::jsonb, null, 3)) c);
  perform outreach_webchat_v_suggest_record(sg, jsonb_build_object('query', 'Show me bridal pieces', 'answer', 'Here are three bridal pieces.', 'confidence', 'high', 'model', 'test', 'products', batch));
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  n := 0;
  begin perform outreach_hub_webchat_send_products(chat, array[p_kundan], 'Here you go', sg); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;   -- not in the suggestion
  begin perform outreach_hub_webchat_send_products(chat, array[]::uuid[], 'Here you go', sg); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  j := outreach_hub_webchat_send_products(chat, array[(batch#>>'{2,id}')::uuid, (batch#>>'{0,id}')::uuid], 'Here are two bridal pieces.', sg);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if sg is not null and (k->>'ok')::boolean and k->>'context' = 'Page: Bridal edit' and (k#>'{products,sources}') = jsonb_build_array(cat) and jsonb_array_length(batch) = 3 and n = 2
     and (select jsonb_array_length(products) from outreach_webchat_ai_suggestions where id = sg) = 3
     and (select status from outreach_webchat_ai_suggestions where id = sg) = 'used' and j->>'content_type' = 'text' and j->>'text' = 'Here are two bridal pieces.'
     and jsonb_array_length(j#>'{content_attributes,products}') = 2 and j#>>'{content_attributes,products,0,id}' = batch#>>'{2,id}' and j#>>'{content_attributes,products,1,id}' = batch#>>'{0,id}'
     and jsonb_array_length((outreach_webchat__message_json((select m from outreach_messages m where m.id = (j->>'id')::uuid)))#>'{content_attributes,products}') = 2
    then log := log || E'\nok   Review: the suggestion stores three cards; the agent removes one and the visitor gets the two kept, in the agent''s order; the suggestion is used';
    else fails := fails + 1; log := log || E'\nFAIL review cards: n=' || n || ' ' || left(coalesce(j::text, 'null'), 400); end if;

  -- ============================================================ 11. the agent's Product button and the connector
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  k := outreach_hub_product_search(ws, 'earrings', null, null, ib, 10);
  n := jsonb_array_length(outreach_hub_product_search(ws, null, 40000, null, ib, 10));
  j := outreach_hub_webchat_send_products(chat, array[p_ear, p_oos], null, null);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if k#>>'{0,id}' = p_ear::text and n = 2 and j->>'content_type' = 'cards' and jsonb_array_length(j#>'{content_attributes,products}') = 2
     and j#>>'{content_attributes,items,0,title}' = 'Jadau Earrings' and j#>>'{content_attributes,items,0,description}' = 'INR 18,500.00' and j#>>'{content_attributes,items,0,actions,0,uri}' = 'https://aurum.shop/products/jadau-earrings'
     and (j#>'{content_attributes,products,1}') ? 'variant_id' is not true and (j#>>'{content_attributes,products,1,available}')::boolean = false
    then log := log || E'\nok   agent: a member searches the website''s catalogue (text, or everything under a price) and sends cards; an out-of-stock card has no Add to cart; old widgets get the same cards in the plain shape';
    else fails := fails + 1; log := log || E'\nFAIL agent cards: n=' || n || ' ' || left(coalesce(j::text, 'null'), 400); end if;

  -- ============================================================ 12. events → the report's Products block
  perform outreach_webchat_v_event(vis, chat, 'product:shown', jsonb_build_object('ids', jsonb_build_array(p_ear, p_ring)));
  perform outreach_webchat_v_event(vis, chat, 'product:clicked', jsonb_build_object('id', p_ear, 'action', 'view'));
  perform outreach_webchat_v_event(vis, chat, 'product:clicked', jsonb_build_object('id', p_ear, 'action', 'ask'));
  perform outreach_webchat_v_event(vis, chat, 'product:added_to_cart', jsonb_build_object('id', p_ear, 'variant_id', '9003'));
  insert into outreach_webchat_ai_turns(workspace_id, inbox_id, chat_id, visitor_id, query, answer, confidence, product_search)
  values (ws, ib, chat, vis, 'silver anklets under 2k', 'We do not have silver anklets. What is your budget?', 'high', '{"q": "silver anklets", "max_price": 2000, "found": 0, "shopping": true}'::jsonb),
         (ws, ib, chat, vis, 'what is your return policy', '30 days.', 'high', '{"q": "return policy", "found": 0, "shopping": false}'::jsonb);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_report(ws, ib, current_date - 1, current_date);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  k := j->'products';
  if (k->>'answers')::int = 3 and (k->>'answers_with_products')::int = 1 and (k->>'cards_shown')::int = 2 and (k->>'clicks')::int = 2 and (k->>'add_to_carts')::int = 1
     and k#>>'{top_clicked,0,title}' = 'Jadau Earrings' and (k#>>'{top_clicked,0,n}')::int = 2 and jsonb_array_length(k->'top_recommended') = 2
     and jsonb_array_length(k->'not_found') = 1 and k#>>'{not_found,0,query}' = 'silver anklets under 2k' and k#>>'{not_found,0,chat_id}' = chat::text
     and (j#>>'{by_source,element_button}')::int = 1 and (j#>>'{by_source,ask}')::int = 1 and (j->>'conversations')::int = 2
    then log := log || E'\nok   report: answers with products, cards shown, clicks, add-to-carts, top products, asked-for-not-found (not the policy question), conversations by the new sources';
    else fails := fails + 1; log := log || E'\nFAIL report: ' || left(coalesce(k::text, 'null'), 600) || ' ' || coalesce((j->'by_source')::text, 'null'); end if;

  -- ============================================================ 13. the catalogue's table in the app
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  j := outreach_hub_catalogue_products(cat, null, 2, 2);
  k := outreach_hub_catalogue_products(cat, 'polki', 50, 0);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (j->>'total')::int = 5 and jsonb_array_length(j->'products') = 2 and j#>>'{source,catalogue,provider}' = 'shopify' and (j#>>'{source,products}')::int = 5 and (j#>>'{source,used_by}')::int = 1
     and (k->>'total')::int = 2 and (k#>'{products,0}') ?& array['id', 'title', 'price', 'currency', 'available', 'ai_hidden', 'pinned_keywords', 'seen_at', 'image']
    then log := log || E'\nok   catalogue_products: paged and searchable for a member; the source says how many products it has and that one website uses it';
    else fails := fails + 1; log := log || E'\nFAIL catalogue_products: ' || left(coalesce(j::text, 'null'), 300); end if;

  -- ============================================================ 14. the next complete sync: a product the store dropped is gone; old cards still render
  perform pg_sleep(0.01);
  j := outreach_catalogue_begin(cat); started := (j->>'started_at')::timestamptz;
  batch := (select jsonb_agg(jsonb_build_object('external_id', p.external_id, 'handle', p.handle, 'url', p.url, 'title', p.title, 'price', p.price + 500, 'product_type', p.product_type, 'tags', to_jsonb(p.tags), 'available', p.available))
              from outreach_products p where p.source_id = cat and p.id <> p_ear);
  perform outreach_catalogue_upsert(cat, batch, started);
  k := outreach_catalogue_finish(cat, started, true, '{}'::jsonb);
  if (k->>'removed')::int = 1 and (k->>'products')::int = 4 and (select deleted_at from outreach_products where id = p_ear) is not null
     and (select price from outreach_products where id = p_choker) = 45500 and (select ai_hidden from outreach_products where id = p_kundan) = false
     and (select pinned_keywords from outreach_products where id = p_ring) = array['anniversary', 'gift']
     and outreach_product_search(ws, array[cat], 'jadau earrings', '{}'::jsonb, null, 12) = '[]'::jsonb and outreach_product_resolve(ws, array[cat], 'product:jadau-earrings') is null
     and (select content_attributes#>>'{products,0,title}' from outreach_messages where id = mid) is not null
     and (select catalogue ? 'sync' from outreach_knowledge_sources where id = cat) = false
    then log := log || E'\nok   resync: prices updated, pins kept, the dropped product is marked deleted and never offered again, the card in the old chat is untouched';
    else fails := fails + 1; log := log || E'\nFAIL resync: ' || coalesce(k::text, 'null'); end if;

  -- an empty complete read keeps what we have and reports an error; an error keeps the products too
  j := outreach_catalogue_begin(cat); started := (j->>'started_at')::timestamptz;
  perform pg_sleep(0.01);
  k := outreach_catalogue_finish(cat, (j->>'started_at')::timestamptz + interval '1 second', true, '{}'::jsonb);
  if k->>'status' = 'error' and (select status from outreach_knowledge_sources where id = cat) = 'error' and (select count(*) from outreach_products where source_id = cat and deleted_at is null) = 4
    then log := log || E'\nok   an empty read does not wipe the catalogue: the source shows an error and keeps its products';
    else fails := fails + 1; log := log || E'\nFAIL empty read: ' || coalesce(k::text, 'null'); end if;

  -- ============================================================ 15. the 10,000 limit
  j := outreach_catalogue_begin(cat2); started := (j->>'started_at')::timestamptz;
  insert into outreach_products(workspace_id, source_id, external_id, url, title, price, currency, seen_at)
  select ws, cat2, 'g' || g, 'https://aurum.shop/p/' || g, 'Bulk item ' || g, g, 'INR', clock_timestamp() from generate_series(1, 9999) g;
  j := outreach_catalogue_upsert(cat2, jsonb_build_array(
         jsonb_build_object('external_id', 'n1', 'url', 'https://aurum.shop/p/n1', 'title', 'Ten thousandth'),
         jsonb_build_object('external_id', 'n2', 'url', 'https://aurum.shop/p/n2', 'title', 'One too many'),
         jsonb_build_object('external_id', 'g5', 'url', 'https://aurum.shop/p/5', 'title', 'Bulk item 5 renamed')), started);
  k := outreach_catalogue_finish(cat2, started, true, jsonb_build_object('warning', '1 product was left out: a catalogue holds 10,000 products at most.'));
  if (j->>'upserted')::int = 2 and (j->>'rejected')::int = 1 and (k->>'products')::int = 10000 and (select count(*) from outreach_products where source_id = cat2 and external_id = 'n2') = 0
     and (select title from outreach_products where source_id = cat2 and external_id = 'g5') = 'Bulk item 5 renamed' and (select count(*) from outreach_products where source_id = cat2 and currency = 'INR') = 10000
     and (select catalogue->>'warning' from outreach_knowledge_sources where id = cat2) like '1 product was left out%'
    then log := log || E'\nok   limit: the 10,001st product is rejected with a warning on the source; products already in keep updating; the override currency applies to all';
    else fails := fails + 1; log := log || E'\nFAIL limit: ' || coalesce(j::text, 'null') || ' ' || coalesce(k::text, 'null'); end if;

  -- ============================================================ 16. catalogue settings: sync now, currency, a website that also finds products
  insert into outreach_knowledge_sources(workspace_id, kind, title, url, status) values (ws, 'website', 'Aurum site', 'https://aurum.shop', 'ready') returning id into web;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_hub_catalogue_update(cat, '{"sync": true, "title": "Aurum store", "currency": "usd", "refresh_days": 7}'::jsonb);
  k := outreach_hub_catalogue_update(web, '{"detect_products": true}'::jsonb);
  n := 0;
  begin perform outreach_hub_catalogue_update(cat, '{"refresh_days": 0}'::jsonb); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  begin perform outreach_hub_catalogue_update(cat, '{"storage_path": "x/y.csv"}'::jsonb); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  begin perform outreach_hub_catalogue_update(web, '{"sync": true}'::jsonb); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  started := (outreach_catalogue_begin(web)->>'started_at')::timestamptz;
  perform outreach_catalogue_upsert(web, jsonb_build_array(jsonb_build_object('external_id', 'https://aurum.shop/silver-anklet', 'url', 'https://aurum.shop/silver-anklet', 'title', 'Silver Anklet', 'price', 1800, 'currency', 'INR')), started);
  perform outreach_catalogue_finish(web, started, true, '{}'::jsonb);
  if j->>'status' = 'pending' and j->>'title' = 'Aurum store' and j#>>'{catalogue,currency}' = 'USD' and (j#>>'{catalogue,currency_locked}')::boolean and (j->>'refresh_days')::int = 7
     and (select count(*) from outreach_products where source_id = cat and currency = 'USD') = 5 and n = 3
     and (k->>'detect_products')::boolean and k->>'status' = 'pending'
     and (select status from outreach_knowledge_sources where id = web) = 'pending' and (select catalogue->>'provider' from outreach_knowledge_sources where id = web) = 'crawl'
     and (select (outreach__ks_json(s)->>'products')::int from outreach_knowledge_sources s where s.id = web) = 1
    then log := log || E'\nok   catalogue_update: sync now, rename, currency override applied to the products, refresh days; a website source finds products without touching its crawl status';
    else fails := fails + 1; log := log || E'\nFAIL catalogue_update: n=' || n || ' ' || left(coalesce(j::text, 'null'), 300) || ' ' || left(coalesce(k::text, 'null'), 200); end if;

  -- ============================================================ 17. removing a catalogue takes it off the website; the old card stays
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  perform outreach_knowledge_source_delete(cat);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  k := outreach_webchat_public_config(tok, 'https://aurum.shop');
  if (select settings#>'{ai,products,catalogue_ids}' from outreach_webchat_inboxes where id = ib) = '[]'::jsonb and (select count(*) from outreach_products where source_id = cat) = 0
     and (k#>>'{settings,ai,products,enabled}') = 'false' and outreach_webchat__products_ctx(ib, outreach_webchat__settings(ib)) is null
     and (select content_attributes#>>'{products,0,title}' from outreach_messages where id = mid) is not null
     and (select product_id from outreach_webchat_ai_turns where answer_message_id = mid) is null
    then log := log || E'\nok   delete: the catalogue leaves the website''s picks, its products go, recommending stops, and the chat still shows the card it saved';
    else fails := fails + 1; log := log || E'\nFAIL delete: ' || coalesce((k#>'{settings,ai,products}')::text, 'null'); end if;

  -- ============================================================ 18. grants
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname in ('outreach_product_search', 'outreach_product_resolve', 'outreach_product_get', 'outreach_product__search', 'outreach_product__card', 'outreach_catalogue_begin',
         'outreach_catalogue_upsert', 'outreach_catalogue_progress', 'outreach_catalogue_finish', 'outreach_webchat__products_ctx', 'outreach_webchat__products_public', 'outreach_webchat__products_report',
         'outreach_webchat__buttons_check', 'outreach_webchat__products_fix', 'outreach_webchat__product_sources', 'outreach_webchat__add_to_cart_ok')
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'));
  select count(*) into i from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname in ('outreach_hub_catalogue_add', 'outreach_hub_catalogue_update', 'outreach_hub_catalogue_products', 'outreach_hub_product_set', 'outreach_hub_product_search',
         'outreach_hub_webchat_send_products', 'outreach_hub_knowledge_link')
     and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute');
  if n = 0 and i = 7 and not has_table_privilege('authenticated', 'outreach_products', 'select') and to_regprocedure('public.outreach_wbp__patch(text,text,text[])') is null
    then log := log || E'\nok   grants: the seven app RPCs for signed-in users only; search, sync and settings helpers service only; the products table has no direct access';
    else fails := fails + 1; log := log || E'\nFAIL grants: service functions open=' || n || ' app rpcs=' || i; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (webchat buttons + products 068)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
