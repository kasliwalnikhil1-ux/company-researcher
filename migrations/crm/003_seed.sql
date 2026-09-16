-- =============================================================================
-- Sales CRM — 003 seed: lookups, settings, FX, team, 15 sample deals
-- Lookups are inserted with ON CONFLICT so re-running is safe. Sample data is
-- only inserted when crm_companies is empty.
-- =============================================================================

insert into crm_settings(key, value) values
  ('default_timezone', '"Asia/Kolkata"'),
  ('stale_after_days', '14'),
  ('default_currency', '"USD"'),
  ('studio_name', '"Kaptured"')
on conflict (key) do nothing;

insert into crm_icp_segments(slug, label, sort_order) values
  ('pocketfm_story', 'PocketFM / story', 10),
  ('info_products_schools_app', 'Info products + schools + app', 20),
  ('performance_marketing_d2c', 'Performance marketing (D2C)', 30),
  ('us_agencies_outsource', 'US agencies (outsource)', 40),
  ('pharma', 'Pharma', 50),
  ('smbs_coaches', 'SMBs / coaches', 60),
  ('music_labels', 'Music labels', 70)
on conflict (slug) do nothing;

insert into crm_source_channels(slug, label, sort_order) values
  ('linkedin', 'LinkedIn', 10),
  ('cold_call', 'Cold call', 20),
  ('email', 'Email', 30),
  ('seo', 'SEO', 40),
  ('referral', 'Referral', 50),
  ('inbound_social', 'Inbound social', 60),
  ('reddit', 'Reddit', 70)
on conflict (slug) do nothing;

insert into crm_activity_types(slug, label, sort_order, counts_as) values
  ('call', 'Call', 10, 'dial'),
  ('linkedin_message', 'LinkedIn message', 20, 'linkedin_message'),
  ('linkedin_connect', 'LinkedIn connect', 30, 'linkedin_connect'),
  ('email', 'Email', 40, 'email'),
  ('meeting', 'Meeting', 50, 'meeting')
on conflict (slug) do nothing;

insert into crm_fx_rates(currency, usd_per_unit) values
  ('USD', 1), ('INR', 0.012), ('GBP', 1.27), ('AED', 0.2723), ('EUR', 1.08)
on conflict (currency) do nothing;

-- Team: the app's admin accounts + the two accounts that already use the outreach workspace.
insert into crm_members(user_id, display_name, email)
select u.id, initcap(replace(split_part(u.email, '@', 1), '.', ' ')), u.email
from auth.users u
where u.id in ('2793f3da-9340-44f4-b285-b7836bfb8591','e25d5e21-13fd-46ee-a39a-4c3386b77b65','a9d87562-b873-4ef0-905d-8555094dfda0','43ce9e75-1da2-4967-8da6-c51e56b0ebd3')
on conflict (user_id) do nothing;

-- -----------------------------------------------------------------------------
-- Sample deals (only on an empty CRM)
-- -----------------------------------------------------------------------------
do $$
declare
  owners uuid[]; o1 uuid; o2 uuid;
  seg_story uuid; seg_info uuid; seg_d2c uuid; seg_us uuid; seg_pharma uuid; seg_smb uuid; seg_music uuid;
  ch_li uuid; ch_call uuid; ch_email uuid; ch_seo uuid; ch_ref uuid; ch_social uuid; ch_reddit uuid;
  t_call uuid; t_lim uuid; t_lic uuid; t_email uuid; t_meet uuid;
  tz text := 'Asia/Kolkata';
  today timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  c uuid; ct uuid; ct2 uuid; d uuid; m uuid;
  stages crm_deal_stage_t[];
  i int;
begin
  if exists (select 1 from crm_companies) then return; end if;

  select array_agg(user_id order by created_at) into owners from crm_members where is_active;
  if owners is null then raise notice 'crm seed: no members yet — skipping sample deals'; return; end if;
  o1 := owners[1]; o2 := owners[least(2, array_length(owners, 1))];

  select id into seg_story from crm_icp_segments where slug = 'pocketfm_story';
  select id into seg_info from crm_icp_segments where slug = 'info_products_schools_app';
  select id into seg_d2c from crm_icp_segments where slug = 'performance_marketing_d2c';
  select id into seg_us from crm_icp_segments where slug = 'us_agencies_outsource';
  select id into seg_pharma from crm_icp_segments where slug = 'pharma';
  select id into seg_smb from crm_icp_segments where slug = 'smbs_coaches';
  select id into seg_music from crm_icp_segments where slug = 'music_labels';
  select id into ch_li from crm_source_channels where slug = 'linkedin';
  select id into ch_call from crm_source_channels where slug = 'cold_call';
  select id into ch_email from crm_source_channels where slug = 'email';
  select id into ch_seo from crm_source_channels where slug = 'seo';
  select id into ch_ref from crm_source_channels where slug = 'referral';
  select id into ch_social from crm_source_channels where slug = 'inbound_social';
  select id into ch_reddit from crm_source_channels where slug = 'reddit';
  select id into t_call from crm_activity_types where slug = 'call';
  select id into t_lim from crm_activity_types where slug = 'linkedin_message';
  select id into t_lic from crm_activity_types where slug = 'linkedin_connect';
  select id into t_email from crm_activity_types where slug = 'email';
  select id into t_meet from crm_activity_types where slug = 'meeting';

  -- helper: replace the auto history row with a realistic backdated chain
  create temp table _seed_hist(deal_id uuid, stages crm_deal_stage_t[], started timestamptz) on commit drop;

  -- 1. StoryVerse (PocketFM/story, LinkedIn) — meeting TODAY 11:00 IST, stage meeting_booked
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('StoryVerse Audio', 'https://storyverse.audio', 'India', 'Asia/Kolkata', seg_story, ch_li, 'Serialised audio fiction app, 40 new titles/month. Marketing head wants vertical video trailers for Instagram + YouTube Shorts. Budget owner is the CMO (Rohan).', now() - interval '12 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, linkedin_url, timezone, is_primary) values (c, 'Ananya Iyer', 'Head of Marketing', 'ananya@storyverse.audio', 'https://linkedin.com/in/ananya-iyer', 'Asia/Kolkata', true) returning id into ct;
  insert into crm_contacts(company_id, name, role, email, timezone) values (c, 'Rohan Mehta', 'CMO', 'rohan@storyverse.audio', 'Asia/Kolkata');
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, expected_close_date, next_step, next_step_date, created_at, stage_entered_at)
  values (c, 'meeting_booked', o1, 450000, 'INR', 40, current_date + 21, 'Discovery call with Ananya + Rohan', current_date, now() - interval '12 days', now() - interval '3 days') returning id into d;
  insert into _seed_hist values (d, array['new','contacted','replied','meeting_booked']::crm_deal_stage_t[], now() - interval '12 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_lic, 'outbound', now() - interval '11 days', ch_li, 'Connect request with note about trailer formats', 'accepted', o1),
    (ct, c, d, t_lim, 'outbound', now() - interval '9 days', ch_li, 'Sent 3 sample trailers (romance, thriller, mythology)', null, o1),
    (ct, c, d, t_lim, 'inbound', now() - interval '6 days', ch_li, 'Loved the thriller one — can we do 40/month? Who else should join a call?', 'replied', o1),
    (ct, c, d, t_lim, 'outbound', now() - interval '3 days', ch_li, 'Proposed Thu 11:00 IST, she confirmed and added Rohan', 'booked', o1);
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, attendees, notes) values (d, ct, today + interval '11 hours', 'Asia/Kolkata', array['Ananya Iyer','Rohan Mehta'], 'Discovery: volume, turnaround, formats');

  -- 2. Bright Minds Academy (Info products, cold call) — meeting TODAY 15:30 IST, meeting_booked
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('Bright Minds Academy', 'https://brightminds.in', 'India', 'Asia/Kolkata', seg_info, ch_call, 'JEE/NEET coaching, 3 campuses. Runs Meta ads in-house; creative is the bottleneck.', now() - interval '9 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, phone, timezone, is_primary) values (c, 'Vikram Shah', 'Founder', 'vikram@brightminds.in', '+91 98200 11223', 'Asia/Kolkata', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, next_step, next_step_date, created_at, stage_entered_at)
  values (c, 'meeting_booked', o2, 180000, 'INR', 20, 'Demo call — show ad-creative reel', current_date, now() - interval '9 days', now() - interval '2 days') returning id into d;
  insert into _seed_hist values (d, array['new','contacted','replied','meeting_booked']::crm_deal_stage_t[], now() - interval '9 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_call, 'outbound', now() - interval '8 days', ch_call, 'Gatekeeper, asked to call back', 'no_answer', o2),
    (ct, c, d, t_call, 'outbound', now() - interval '7 days', ch_call, 'Spoke to Vikram 6 min; pain: agency takes 3 weeks per batch', 'connected', o2),
    (ct, c, d, t_email, 'outbound', now() - interval '7 days', ch_email, 'Sent reel + pricing ladder', null, o2),
    (ct, c, d, t_call, 'outbound', now() - interval '2 days', ch_call, 'Booked demo for Thursday 15:30', 'booked', o2);
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, attendees, notes) values (d, ct, today + interval '15 hours 30 minutes', 'Asia/Kolkata', array['Vikram Shah'], 'Demo. He will ask about turnaround.');

  -- 3. Glow Theory (D2C, inbound social) — meeting TODAY 19:00 IST (Dubai 17:30), stage proposal_sent, second meeting
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('Glow Theory', 'https://glowtheory.ae', 'UAE', 'Asia/Dubai', seg_d2c, ch_social, 'Skincare D2C, Dubai. Found us via Instagram reel. Wants UGC-style ads, 30/month, English + Arabic.', now() - interval '25 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, timezone, is_primary) values (c, 'Layla Haddad', 'Growth Lead', 'layla@glowtheory.ae', 'Asia/Dubai', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, expected_close_date, next_step, next_step_date, created_at, stage_entered_at)
  values (c, 'proposal_sent', o1, 22000, 'AED', 30, current_date + 10, 'Proposal walkthrough with Layla + finance', current_date, now() - interval '25 days', now() - interval '5 days') returning id into d;
  insert into _seed_hist values (d, array['new','replied','meeting_booked','meeting_held','proposal_sent']::crm_deal_stage_t[], now() - interval '25 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_lim, 'inbound', now() - interval '25 days', ch_social, 'DM: "do you do UGC ads for skincare?"', 'replied', o1),
    (ct, c, d, t_lim, 'outbound', now() - interval '24 days', ch_social, 'Replied with 4 UGC samples, offered a call', null, o1),
    (ct, c, d, t_email, 'outbound', now() - interval '5 days', ch_email, 'Sent proposal: 30 videos, AED 22k/mo, 5-day turnaround', null, o1);
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, attendees, notes) values (d, ct, now() - interval '8 days', 'Asia/Dubai', array['Layla Haddad'], 'Discovery') returning id into m;
  insert into crm_meeting_captures(meeting_id, outcome, pain_points, commercials_discussed, objections, next_step, next_step_date, raw_notes)
  values (m, 'held', array['our current UGC creators are flaky — half the videos come late','the Arabic voiceovers sound like translations, not native','we cannot test 30 hooks a month with one editor'],
          '{"price": 22000, "currency": "AED", "volume": 30, "notes": "asked about a 3-month pilot"}', array['need Arabic native talent proof','pilot before 12-month commitment'],
          'Send proposal with Arabic samples', (now() - interval '5 days')::date, 'Very warm. Finance sign-off needed above AED 15k.');
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, attendees, notes) values (d, ct, today + interval '19 hours', 'Asia/Dubai', array['Layla Haddad','Omar (finance)'], 'Proposal walkthrough');

  -- 4. Northstar Creative Partners (US agency, referral) — negotiation, USD, meeting held yesterday (uncaptured → shows as uncaptured)
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('Northstar Creative Partners', 'https://northstarcp.com', 'United States', 'America/New_York', seg_us, ch_ref, 'Boutique agency in Austin, white-labels production. Referred by Glow Theory''s ex-agency. Wants a dedicated pod.', now() - interval '40 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, timezone, is_primary) values (c, 'Megan Cole', 'Managing Partner', 'megan@northstarcp.com', 'America/Chicago', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, expected_close_date, next_step, next_step_date, created_at, stage_entered_at)
  values (c, 'negotiation', o1, 12000, 'USD', 60, current_date + 7, 'Redline MSA and confirm pod start date', current_date + 2, now() - interval '40 days', now() - interval '6 days') returning id into d;
  insert into _seed_hist values (d, array['new','contacted','replied','meeting_booked','meeting_held','proposal_sent','negotiation']::crm_deal_stage_t[], now() - interval '40 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_email, 'outbound', now() - interval '39 days', ch_email, 'Intro via referral', null, o1),
    (ct, c, d, t_email, 'inbound', now() - interval '37 days', ch_email, 'Interested, wants to see a white-label case', 'replied', o1),
    (ct, c, d, t_email, 'outbound', now() - interval '13 days', ch_email, 'Sent proposal: dedicated 3-person pod, $12k/mo', null, o1),
    (ct, c, d, t_email, 'inbound', now() - interval '6 days', ch_email, 'Legal wants net-45 and IP assignment clause', 'replied', o1);
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, attendees, notes) values (d, ct, now() - interval '30 days', 'America/Chicago', array['Megan Cole'], 'Discovery') returning id into m;
  insert into crm_meeting_captures(meeting_id, outcome, pain_points, commercials_discussed, objections, next_step, next_step_date)
  values (m, 'held', array['we turn down $40k/month of video work because we cannot staff it','clients expect 48-hour revisions and our freelancers ghost on weekends'],
          '{"price": 12000, "currency": "USD", "volume": 60, "notes": "dedicated pod, white-label"}', array['timezone overlap with Austin','IP ownership'],
          'Send pod proposal', (now() - interval '13 days')::date);
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, attendees, notes) values (d, ct, today - interval '1 day' + interval '21 hours 30 minutes', 'America/Chicago', array['Megan Cole','Northstar legal'], 'Commercial + legal review');

  -- 5. MediCore Labs (Pharma, email) — meeting_held, held 4 days ago, captured; next step slipping (date yesterday)
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('MediCore Labs', 'https://medicorelabs.com', 'India', 'Asia/Kolkata', seg_pharma, ch_email, 'Mid-size pharma, Hyderabad. Needs MoA explainer videos + doctor-facing content. Compliance review adds a week.', now() - interval '20 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, timezone, is_primary) values (c, 'Dr. Priya Nair', 'Brand Manager', 'priya.nair@medicorelabs.com', 'Asia/Kolkata', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, next_step, next_step_date, created_at, stage_entered_at)
  values (c, 'meeting_held', o2, 320000, 'INR', 8, 'Send compliance-friendly storyboard sample', current_date - 1, now() - interval '20 days', now() - interval '4 days') returning id into d;
  insert into _seed_hist values (d, array['new','contacted','replied','meeting_booked','meeting_held']::crm_deal_stage_t[], now() - interval '20 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_email, 'outbound', now() - interval '19 days', ch_email, 'Cold email: MoA explainers', null, o2),
    (ct, c, d, t_email, 'inbound', now() - interval '15 days', ch_email, 'Forwarded to brand team, wants a call', 'replied', o2);
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, attendees, notes) values (d, ct, now() - interval '4 days', 'Asia/Kolkata', array['Dr. Priya Nair','Regulatory (Suresh)'], 'Discovery') returning id into m;
  insert into crm_meeting_captures(meeting_id, outcome, pain_points, commercials_discussed, objections, next_step, next_step_date)
  values (m, 'held', array['every video goes through three compliance rounds and agencies bill each round','doctors skip anything over 90 seconds'],
          '{"price": 40000, "currency": "INR", "volume": 8, "notes": "per video, quoted INR 40k"}', array['compliance turnaround','prefers a vendor with pharma references'],
          'Send compliance-friendly storyboard sample', (current_date - 1));

  -- 6. Coach Karan (SMB/coaches, Reddit) — replied; stuck (no next step)
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('Karan Bhatia Coaching', 'https://karanbhatia.co', 'India', 'Asia/Kolkata', seg_smb, ch_reddit, 'Fitness coach, 120k IG followers, sells a INR 15k program. Replied to our Reddit comment.', now() - interval '10 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, timezone, is_primary) values (c, 'Karan Bhatia', 'Founder / Coach', 'karan@karanbhatia.co', 'Asia/Kolkata', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, created_at, stage_entered_at)
  values (c, 'replied', o2, 60000, 'INR', 12, now() - interval '10 days', now() - interval '5 days') returning id into d;
  insert into _seed_hist values (d, array['new','contacted','replied']::crm_deal_stage_t[], now() - interval '10 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_lim, 'outbound', now() - interval '8 days', ch_reddit, 'DM after Reddit thread', null, o2),
    (ct, c, d, t_lim, 'inbound', now() - interval '5 days', ch_reddit, 'Sure, send me pricing', 'replied', o2);

  -- 7. Riff Records (Music labels, LinkedIn) — contacted; STALE (no activity for 20 days)
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('Riff Records', 'https://riffrecords.co.uk', 'United Kingdom', 'Europe/London', seg_music, ch_li, 'Indie label, 30 artists. Wants lyric videos + visualisers.', now() - interval '30 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, timezone, is_primary) values (c, 'Tom Ellery', 'Head of Digital', 'tom@riffrecords.co.uk', 'Europe/London', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, next_step, next_step_date, created_at, stage_entered_at)
  values (c, 'contacted', o1, 4500, 'GBP', 15, 'Follow up with visualiser samples', current_date + 3, now() - interval '30 days', now() - interval '28 days') returning id into d;
  insert into _seed_hist values (d, array['new','contacted']::crm_deal_stage_t[], now() - interval '30 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_lic, 'outbound', now() - interval '28 days', ch_li, 'Connect request', 'accepted', o1),
    (ct, c, d, t_lim, 'outbound', now() - interval '20 days', ch_li, 'Sent lyric video reel', null, o1);

  -- 8. PlotPoint Audio (PocketFM/story, cold call) — WON 5 days ago
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('PlotPoint Audio', 'https://plotpoint.fm', 'India', 'Asia/Kolkata', seg_story, ch_call, 'Audio drama studio. Signed for 25 trailers/month.', now() - interval '45 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, timezone, is_primary) values (c, 'Neha Kulkarni', 'VP Growth', 'neha@plotpoint.fm', 'Asia/Kolkata', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, created_at, stage_entered_at, closed_at)
  values (c, 'won', o1, 275000, 'INR', 25, now() - interval '45 days', now() - interval '5 days', now() - interval '5 days') returning id into d;
  insert into _seed_hist values (d, array['new','contacted','replied','meeting_booked','meeting_held','proposal_sent','negotiation','won']::crm_deal_stage_t[], now() - interval '45 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_call, 'outbound', now() - interval '44 days', ch_call, 'Cold call, 9 min', 'connected', o1),
    (ct, c, d, t_email, 'outbound', now() - interval '20 days', ch_email, 'Proposal sent', null, o1),
    (ct, c, d, t_call, 'outbound', now() - interval '5 days', ch_call, 'Verbal yes, PO next week', 'connected', o1);
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, attendees) values (d, ct, now() - interval '35 days', 'Asia/Kolkata', array['Neha Kulkarni']) returning id into m;
  insert into crm_meeting_captures(meeting_id, outcome, pain_points, commercials_discussed, objections, next_step, next_step_date)
  values (m, 'held', array['our trailers look the same as every other audio app','we cannot test 30 hooks a month with one editor'], '{"price": 275000, "currency": "INR", "volume": 25}', array['wants exclusivity in audio-fiction category'], 'Send proposal', (now() - interval '20 days')::date);

  -- 9. SkillForge (Info products, SEO) — LOST 10 days ago (budget)
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('SkillForge', 'https://skillforge.io', 'India', 'Asia/Kolkata', seg_info, ch_seo, 'Upskilling app. Came via blog post on ad creative testing.', now() - interval '35 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, timezone, is_primary) values (c, 'Arjun Rao', 'Performance Marketing Lead', 'arjun@skillforge.io', 'Asia/Kolkata', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, lost_reason, created_at, stage_entered_at, closed_at)
  values (c, 'lost', o2, 150000, 'INR', 20, 'Budget frozen till next quarter; in-house editor hired', now() - interval '35 days', now() - interval '10 days', now() - interval '10 days') returning id into d;
  insert into _seed_hist values (d, array['new','replied','meeting_booked','meeting_held','proposal_sent','lost']::crm_deal_stage_t[], now() - interval '35 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_email, 'inbound', now() - interval '35 days', ch_seo, 'Inbound form: "need 20 ad videos/month"', 'replied', o2),
    (ct, c, d, t_email, 'outbound', now() - interval '16 days', ch_email, 'Proposal sent', null, o2),
    (ct, c, d, t_email, 'inbound', now() - interval '10 days', ch_email, 'Budget frozen, revisit in Q1', 'replied', o2);
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, attendees) values (d, ct, now() - interval '22 days', 'Asia/Kolkata', array['Arjun Rao']) returning id into m;
  insert into crm_meeting_captures(meeting_id, outcome, pain_points, commercials_discussed, objections, next_step, next_step_date)
  values (m, 'held', array['our CPA doubles every time we run out of fresh creatives','freelancers do not understand performance hooks'], '{"price": 150000, "currency": "INR", "volume": 20}', array['price per video vs freelancer rates'], 'Send proposal', (now() - interval '16 days')::date);

  -- 10. Velvet Skin Co (D2C, LinkedIn) — NO-SHOW 2 days ago, captured; follow-up date today
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('Velvet Skin Co', 'https://velvetskin.in', 'India', 'Asia/Kolkata', seg_d2c, ch_li, 'D2C skincare, Bangalore. Founder-led marketing.', now() - interval '14 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, timezone, is_primary) values (c, 'Sneha Reddy', 'Founder', 'sneha@velvetskin.in', 'Asia/Kolkata', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, next_step, next_step_date, created_at, stage_entered_at)
  values (c, 'meeting_booked', o2, 120000, 'INR', 16, 'Call Sneha to rebook; send 2 skincare UGC samples first', current_date, now() - interval '14 days', now() - interval '6 days') returning id into d;
  insert into _seed_hist values (d, array['new','contacted','replied','meeting_booked']::crm_deal_stage_t[], now() - interval '14 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_lic, 'outbound', now() - interval '13 days', ch_li, 'Connect', 'accepted', o2),
    (ct, c, d, t_lim, 'inbound', now() - interval '8 days', ch_li, 'Happy to chat next week', 'replied', o2);
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, attendees) values (d, ct, now() - interval '2 days', 'Asia/Kolkata', array['Sneha Reddy']) returning id into m;
  insert into crm_meeting_captures(meeting_id, outcome, no_show_reason, follow_up_action, follow_up_date)
  values (m, 'no_show', 'Did not join; no reply to reminder 10 min before', 'Call Sneha to rebook; send 2 skincare UGC samples first', current_date);

  -- 11. Pixel Pilots Agency (US agency, email) — new (fresh lead, yesterday)
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('Pixel Pilots Agency', 'https://pixelpilots.agency', 'United States', 'America/Los_Angeles', seg_us, ch_email, 'Performance agency in LA, 12 D2C clients.', now() - interval '1 day') returning id into c;
  insert into crm_contacts(company_id, name, role, email, timezone, is_primary) values (c, 'Derek Lin', 'Head of Creative', 'derek@pixelpilots.agency', 'America/Los_Angeles', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, videos_per_month, next_step, next_step_date, created_at, stage_entered_at)
  values (c, 'new', o1, 40, 'First email with agency case study', current_date + 1, now() - interval '1 day', now() - interval '1 day') returning id into d;
  insert into _seed_hist values (d, array['new']::crm_deal_stage_t[], now() - interval '1 day');

  -- 12. Sunrise Pharma (Pharma, referral) — contacted yesterday
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('Sunrise Pharma', 'https://sunrisepharma.in', 'India', 'Asia/Kolkata', seg_pharma, ch_ref, 'Referred by MediCore''s Priya. OTC brand launching a vitamin gummy.', now() - interval '3 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, phone, timezone, is_primary) values (c, 'Amit Desai', 'Marketing Manager', 'amit@sunrisepharma.in', '+91 99870 44556', 'Asia/Kolkata', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, next_step, next_step_date, created_at, stage_entered_at)
  values (c, 'contacted', o2, 200000, 'INR', 10, 'Call back Friday 11:00 as agreed', current_date + 1, now() - interval '3 days', now() - interval '1 day') returning id into d;
  insert into _seed_hist values (d, array['new','contacted']::crm_deal_stage_t[], now() - interval '3 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_call, 'outbound', now() - interval '1 day' - interval '2 hours', ch_call, 'Spoke 4 min, launch is in 6 weeks', 'connected', o2),
    (ct, c, d, t_call, 'outbound', now() - interval '1 day' - interval '5 hours', ch_call, 'No answer', 'no_answer', o2),
    (ct, c, d, t_call, 'outbound', now() - interval '1 day' - interval '6 hours', ch_call, 'No answer', 'no_answer', o2);

  -- 13. Mindset Mastery (SMB/coaches, inbound social) — proposal_sent; slipping (next step 3 days late)
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('Mindset Mastery', 'https://mindsetmastery.co', 'United Kingdom', 'Europe/London', seg_smb, ch_social, 'Business coach, sells GBP 2k cohort. Wants talking-head edits + captions.', now() - interval '28 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, timezone, is_primary) values (c, 'Olivia Grant', 'Founder', 'olivia@mindsetmastery.co', 'Europe/London', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, next_step, next_step_date, created_at, stage_entered_at)
  values (c, 'proposal_sent', o1, 1800, 'GBP', 20, 'Chase proposal feedback', current_date - 3, now() - interval '28 days', now() - interval '9 days') returning id into d;
  insert into _seed_hist values (d, array['new','replied','meeting_booked','meeting_held','proposal_sent']::crm_deal_stage_t[], now() - interval '28 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_lim, 'inbound', now() - interval '28 days', ch_social, 'Instagram DM asking for rates', 'replied', o1),
    (ct, c, d, t_email, 'outbound', now() - interval '9 days', ch_email, 'Proposal: 20 edits/month GBP 1,800', null, o1);
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, attendees) values (d, ct, now() - interval '12 days', 'Europe/London', array['Olivia Grant']) returning id into m;
  insert into crm_meeting_captures(meeting_id, outcome, pain_points, commercials_discussed, objections, next_step, next_step_date)
  values (m, 'held', array['I spend my Sundays editing instead of selling','captions are always slightly wrong and it looks amateur'], '{"price": 1800, "currency": "GBP", "volume": 20}', array['cheaper Fiverr editors'], 'Send proposal', (now() - interval '9 days')::date);

  -- 14. Tempo Tunes (Music labels, email) — replied; meeting TOMORROW
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('Tempo Tunes', 'https://tempotunes.in', 'India', 'Asia/Kolkata', seg_music, ch_email, 'Regional music label (Punjabi/Haryanvi), 15 releases/month.', now() - interval '7 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, timezone, is_primary) values (c, 'Harpreet Singh', 'Label Manager', 'harpreet@tempotunes.in', 'Asia/Kolkata', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, next_step, next_step_date, created_at, stage_entered_at)
  values (c, 'replied', o2, 90000, 'INR', 15, 'Intro call tomorrow', current_date + 1, now() - interval '7 days', now() - interval '2 days') returning id into d;
  insert into _seed_hist values (d, array['new','contacted','replied']::crm_deal_stage_t[], now() - interval '7 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_email, 'outbound', now() - interval '6 days', ch_email, 'Cold email with lyric-video reel', null, o2),
    (ct, c, d, t_email, 'inbound', now() - interval '2 days', ch_email, 'Interesting — free tomorrow afternoon?', 'replied', o2);
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, attendees) values (d, ct, today + interval '1 day' + interval '16 hours', 'Asia/Kolkata', array['Harpreet Singh']);

  -- 15. Lumen Ads Co (D2C, cold call) — contacted; stuck (no next-step date)
  insert into crm_companies(name, website, country, timezone, icp_segment_id, source_channel_id, notes, created_at)
  values ('Lumen Ads Co', 'https://lumenads.co', 'India', 'Asia/Kolkata', seg_d2c, ch_call, 'Runs paid social for 6 D2C brands out of Mumbai.', now() - interval '5 days') returning id into c;
  insert into crm_contacts(company_id, name, role, email, phone, timezone, is_primary) values (c, 'Farhan Khan', 'Co-founder', 'farhan@lumenads.co', '+91 98333 77889', 'Asia/Kolkata', true) returning id into ct;
  insert into crm_deals(company_id, stage, owner_id, value_monthly, currency, videos_per_month, next_step, created_at, stage_entered_at)
  values (c, 'contacted', o1, 160000, 'INR', 24, 'Send pricing ladder', now() - interval '5 days', now() - interval '4 days') returning id into d;
  insert into _seed_hist values (d, array['new','contacted']::crm_deal_stage_t[], now() - interval '5 days');
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id) values
    (ct, c, d, t_call, 'outbound', now() - interval '4 days', ch_call, 'Spoke briefly, send pricing', 'connected', o1),
    (ct, c, d, t_call, 'outbound', now() - interval '1 day' - interval '3 hours', ch_call, 'Voicemail', 'voicemail', o1);

  -- Yesterday's extra dials/connects for the scoreboard (no deal attached → company-level)
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id)
  select ct, c, d, t_call, 'outbound', now() - interval '1 day' - (g || ' minutes')::interval, ch_call, 'Dial', case when g % 4 = 0 then 'connected' else 'no_answer' end, o1 from generate_series(10, 120, 10) g;
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id)
  select ct, c, d, t_lic, 'outbound', now() - interval '1 day' - (g || ' minutes')::interval, ch_li, 'Connect request', case when g % 3 = 0 then 'accepted' else null end, o2 from generate_series(5, 60, 5) g;

  -- Commitments: yesterday (to compare) and today
  insert into crm_commitments(owner_id, commit_date, targets, notes) values
    (o1, current_date - 1, '{"dials": 15, "connects": 4, "meetings_booked": 1}', 'Focus: story apps'),
    (o1, current_date, '{"dials": 20, "connects": 5, "linkedin_connects": 10, "meetings_booked": 1}', null)
  on conflict do nothing;
  if o2 <> o1 then
    insert into crm_commitments(owner_id, commit_date, targets, notes) values
      (o2, current_date - 1, '{"linkedin_connects": 10, "emails": 10, "meetings_booked": 1}', null),
      (o2, current_date, '{"dials": 10, "linkedin_connects": 15, "proposals_sent": 1}', 'Chase MediCore + Sunrise')
    on conflict do nothing;
  end if;

  -- Replace the auto history rows with realistic backdated chains
  for d, stages, today in select deal_id, _seed_hist.stages, started from _seed_hist loop
    delete from crm_stage_history where deal_id = d;
    for i in 1 .. array_length(stages, 1) loop
      insert into crm_stage_history(deal_id, from_stage, to_stage, changed_at, changed_by, reason)
      values (d, case when i = 1 then null else stages[i-1] end, stages[i],
              today + ((i - 1) * ((select stage_entered_at from crm_deals where id = d) - today) / greatest(array_length(stages, 1) - 1, 1)),
              o1, case when stages[i] = 'lost' then 'budget frozen' end);
    end loop;
  end loop;

  -- Captures copy their next step onto the deal (by design); restore the *current* next steps for deals that moved on since
  update crm_deals dd set next_step = 'Proposal walkthrough with Layla + finance', next_step_date = current_date from crm_companies cc where cc.id = dd.company_id and cc.name = 'Glow Theory';
  update crm_deals dd set next_step = 'Redline MSA and confirm pod start date', next_step_date = current_date + 2 from crm_companies cc where cc.id = dd.company_id and cc.name = 'Northstar Creative Partners';
  update crm_deals dd set next_step = 'Chase proposal feedback', next_step_date = current_date - 3 from crm_companies cc where cc.id = dd.company_id and cc.name = 'Mindset Mastery';

  -- Meetings were "booked" a few days before they happen (scoreboard/channel quality read created_at)
  update crm_meetings set created_at = scheduled_at - interval '3 days', updated_at = scheduled_at - interval '3 days';

  -- Stale deal must have no recent activity: pin last_activity_at to its last touch
  update crm_deals dd set last_activity_at = (select max(occurred_at) from crm_activities a where a.deal_id = dd.id);

  -- Seeded captures were inserted directly (not via crm_capture_meeting): tokenise their pain points into tags the same way
  insert into crm_pain_point_tags(slug, label)
  select distinct crm_slugify(left(pp, 60)), left(trim(pp), 80) from crm_meeting_captures cp, unnest(cp.pain_points) pp where crm_slugify(left(pp, 60)) <> ''
  on conflict (slug) do nothing;
  insert into crm_capture_pain_tags(capture_id, tag_id, verbatim)
  select cp.id, t.id, pp from crm_meeting_captures cp, unnest(cp.pain_points) pp join crm_pain_point_tags t on t.slug = crm_slugify(left(pp, 60))
  on conflict do nothing;
end $$;
