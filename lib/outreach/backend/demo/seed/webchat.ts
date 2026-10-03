/**
 * Demo seed: the website (webchat inbox) with full settings, visitors, canned replies, campaigns. Runs after the AI seed
 * (its knowledge sources, Q&A and catalogue are picked here when they exist) and BEFORE the inbox seed, which attaches
 * its website conversations to WEBCHAT.sender / WEBCHAT.inbox and may put the sample voice call
 * (SAMPLE_VOICE_CALL_ID, in outreach_webchat_voice_calls) on one of them as a voice_call card.
 */
import type { DemoStore, Row } from '../store';
import { DEMO_WS_ID, MEMBER, WEBCHAT } from './ids';
import { sampleTurns, turnSeconds } from '../webchat/voice';

const D = 86_400_000, M = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** The seeded voice call (not a test): recording, summary, collected details. */
export const SAMPLE_VOICE_CALL_ID = '00000000-0000-4000-8000-3c0000000001';

const hex = (s: DemoStore, n: number) => Array.from({ length: n }, () => s.int(0, 255).toString(16).padStart(2, '0')).join('');

export function seedWebchat(s: DemoStore, now: number): void {
  const sources = s.t('outreach_knowledge_sources').filter((x) => x.workspace_id === DEMO_WS_ID);
  const catalogues = sources.filter((x) => x.kind === 'catalogue').map((x) => x.id);
  const knowledge = sources.filter((x) => x.kind !== 'catalogue').map((x) => x.id);
  const hasProducts = s.t('outreach_products').some((p) => catalogues.includes(p.source_id) && !p.deleted_at);

  // the synthetic WEBCHAT sender the website's conversations belong to (049: never planned, warmed or billed)
  s.insert('outreach_senders', {
    id: WEBCHAT.sender, workspace_id: DEMO_WS_ID, client_id: null, owner_user_id: MEMBER.maya, owner_email: null, provider: 'WEBCHAT', unipile_account_id: null, previous_unipile_account_id: null,
    disconnected_at: null, billing_paused_at: null, auth_method: 'oauth', display_name: 'Northwind Growth', label: null, public_identifier: null, provider_user_id: null, picture_url: null,
    is_premium: false, has_sales_nav: false, has_recruiter: false, connections_count: null, status: 'ok', status_reason: null, deleted_at: null, proxy_country: null, user_agent: null,
    timezone: 'America/New_York', schedule: {}, warmup_level: 5, warmup_locked_until: null, health_score: 100, health_breakdown: {}, manual_caps: {}, rejects_1h: 0, paused_until: null,
    invite_blocked_until: null, reconnect_attempts: 0, connected_at: iso(now - 75 * D), last_ok_at: iso(now - 5 * M), last_disconnect_at: null, last_synced_at: null, extension_token_issued_at: null,
    running_dry_at: null, alert_emails: [], booking_link: null, signature: null, bcc_address: null, parent_sender_id: null, monthly_cost: 0, track_replies: null, enrich_empty_streak: 0,
    enrich_backoff_until: null, profile_qa_score: null, profile_identity_unverified: false, profile_snapshot_at: null, outreach_allowed_from: null, provider_warning: null,
    account_age_attested_at: null, account_age_attested_by: null, account_age_months: null, created_at: iso(now - 75 * D), updated_at: iso(now - 2 * D),
  });

  const settings: Row = {
    appearance: { brand_name: 'Northwind', logo_url: null, bot_avatar_url: null, welcome_title: 'Hi there 👋', welcome_tagline: 'Questions about outreach, pricing or our services? Ask away.',
      accent: '#4f46e5', widget_bg: '#ffffff', chat_bg: '#f8f8fa', font: 'Inter', theme: 'light', mode: 'bubble', z_index: 2147483000, custom_css: '', drawer_side: 'right', panel_width: 384, mobile: {} },
    launcher: {
      desktop: { type: 'button', size: 'md', position: 'right', margin_bottom: 24, margin_side: 24, text: 'Chat with us' },
      mobile: { type: 'icon', size: 'md', position: 'right', margin_bottom: 20, margin_side: 20, text: 'Chat' },
      show_unread_count: true, show_unread_previews: true, hide: false, campaigns_open: false, online_dot: true,
      // no built-in clip ships with the widget (public/widget/v1/presets/presets.json is empty): the bubble is off
      video: { enabled: false, url: null, kind: 'video', shape: 'circle', size: 120, ratio: '1:1', fit: 'cover', focus_x: 50, focus_y: 50, zoom: 100, border_color: '#ffffff', border_width: 3,
        expanded_width: 420, expanded_ratio: 'auto', sound: true, questions: ['How does pricing work?', 'Can I see a demo?'], questions_position: 'over', cta_text: 'Text', question_bg: '#111827', question_color: '#ffffff', cta_bg: null, cta_color: '#ffffff', languages: [], variants: [] },
    },
    popup: { enabled: true, text: '👋 Want to see how teams book more meetings?', image_url: null, delay_s: 4, position: 'above' },
    messages: { greeting_enabled: true, greeting: 'Hi! I am the Northwind assistant. Ask me about pricing, how outreach works, or book a call with the team.', reply_time: 'minutes',
      available_message: "We're online", unavailable_message: "We're away right now. Leave a message and we'll get back to you within a business day.",
      email_capture_prompt: "We'll reply here and by email — what's your email?", end_message: 'Thanks for chatting with Northwind!', placeholder: 'Ask a question…',
      privacy_url: 'https://northwind.example.com/privacy', quick_replies: ['Pricing', 'Book a demo', 'How does it work?', 'Talk to a person'],
      handoff_message: 'Connecting you with someone from the team — one moment.', handoff_offline_message: "Our team is offline right now. Leave your email and we'll reply as soon as we're back." },
    pre_chat: { enabled: false, message: 'Tell us a bit about yourself so we can help.', when: 'offline_only',
      fields: [
        { key: 'name', label: 'Name', type: 'text', visible: true, required: false, placeholder: '' },
        { key: 'email', label: 'Work email', type: 'email', visible: true, required: true, placeholder: 'you@company.com' },
        { key: 'phone', label: 'Phone', type: 'phone', visible: false, required: false, placeholder: '' },
        { key: 'team_size', label: 'Team size', type: 'list', visible: true, required: false, options: ['1–10', '11–50', '51–200', '200+'] },
      ],
      consent: { enabled: true, label: 'I agree to be contacted about my request.', link: 'https://northwind.example.com/privacy', text_version: 'v2' } },
    features: { file_picker: true, emoji_picker: true, restart: true, end_conversation: true, allow_after_resolved: true, single_conversation: false, sounds: true, read_receipts: true,
      show_agent_names: true, transcript: true, email_capture: true, powered_by: true, show_offline_status: true, hide_outside_hours: false, markdown: true },
    csat: { enabled: true, scale: 'emoji', ask_comment: true, by_email: true },
    continuity: { enabled: true, inactivity_min: 5, digest_window_min: 15, include_transcript_on_resolve: true },
    ai: {
      mode: 'first', knowledge_source_ids: knowledge, persona: 'You are the Northwind Growth assistant. Friendly and concise. Never quote custom enterprise pricing; offer a call with the team instead.',
      allowed_topics: 'Northwind services, outreach, pricing, onboarding, booking a call',
      handoff: { keywords: ['pricing quote', 'talk to a person', 'speak to a human', 'complaint', 'refund', 'cancel'], max_turns: 8, low_confidence_streak: 2, leads_in_sequence: true },
      show_sources: true, hourly_cap_per_visitor: 30, review_timeout_min: 10,
      products: { enabled: hasProducts, catalogue_ids: catalogues, max: 3, show_prices: true, include_oos: false, add_to_cart: false, utm: true },
    },
    targeting: { url_rules: [{ op: 'starts_with', value: '/checkout', action: 'hide' }], hide_mobile: false, hide_desktop: false, identified_only: false, countries_include: [], countries_exclude: [] },
    security: { rate_limits: { visitor_10s: 10, visitor_1h: 200, ip_1m: 20, ip_1h: 300, inbox_1m: 2000 }, turnstile_enabled: false, turnstile_site_key: null, consent_mode: false,
      allow_localhost: false, attachments: { max_mb: 10, allow_zip: false }, profanity_filter: true },
    assignment: { auto: true, capacity: 8, unassign_offline_min: 30 },
    locale: { default: 'en', use_browser: true, strings: {} },
    ask_buttons: [
      { id: 'hdr-main', kind: 'header', selector: 'header nav, header', position: 'end', label: 'Ask AI', style: 'filled', icon: true, click: 'open', mode: 'sidebar', url_rules: [], enabled: true },
      { id: 'el-cards', kind: 'element', selector: '.product-card', position: 'inside', label: 'Ask about this', style: 'outline', icon: true, click: 'ask', text: 'Tell me more about this one', context: 'product', mode: null, url_rules: [], enabled: true },
    ],
    selection_ask: { enabled: true, area: 'main, article', label: 'Ask AI' },
    shortcut: { enabled: null },
    voice: {
      enabled: true, voice_id: 'demoVoiceAria01', voice_name: 'Aria', speed: 1.0, stability: 0.5, language: 'en', languages: ['es'], auto_language: true, hinglish: false,
      greeting: { en: "Hi! I'm the Northwind assistant. What can I help you with today?", es: '¡Hola! Soy el asistente de Northwind. ¿En qué puedo ayudarte?' },
      instructions: 'Keep answers to two sentences. Offer to text links in the chat instead of reading them out.', max_minutes: 5, silence_end_s: 20, model: 'fast', tool_sound: 'typing',
      collect: ['name', 'phone', 'need'], record: true, retention_days: 30, consent_text: null,
      ui: { start_text: 'Voice', start_hint: 'Speak with our AI assistant', orb_1: null, orb_2: '#c7a3ff', avatar: 'logo', labels: {}, captions: true, show_on: { home: true, composer: true, launcher: false } },
    },
  };
  const businessHours = { tz: 'America/New_York', weekly: { mon: [['08:00', '20:00']], tue: [['08:00', '20:00']], wed: [['08:00', '20:00']], thu: [['08:00', '20:00']], fri: [['08:00', '18:00']], sat: [['10:00', '16:00']], sun: [] }, holidays: [] };
  const domains = ['northwind.example.com', '*.example.com'];
  const reply = s.t('outreach_senders').find((x) => x.workspace_id === DEMO_WS_ID && x.provider === 'GMAIL');
  s.insert('outreach_webchat_inboxes', {
    id: WEBCHAT.inbox, workspace_id: DEMO_WS_ID, client_id: null, sender_id: WEBCHAT.sender, name: 'Northwind Growth', website_token: hex(s, 16), hmac_token: hex(s, 24), enforce_identity: false,
    allowed_domains: domains, settings, config_version: 2, ai_enabled: true, reply_mailbox_id: reply?.id ?? null, business_hours: businessHours, is_active: true,
    installed_origins: { 'https://northwind.example.com': iso(now - 18 * M), 'https://blog.example.com': iso(now - 3 * D) }, created_by: MEMBER.maya, created_at: iso(now - 75 * D), updated_at: iso(now - 2 * D), deleted_at: null,
  });
  for (const [u, auto] of [[MEMBER.maya, true], [MEMBER.sam, true], [MEMBER.priya, false]] as Array<[string, boolean]>) {
    s.insert('outreach_webchat_inbox_members', { inbox_id: WEBCHAT.inbox, user_id: u, auto_assign: auto, last_assigned_at: iso(now - s.int(1, 48) * 3_600_000), created_at: iso(now - 75 * D) });
  }
  s.insert('outreach_webchat_settings_history', [
    { inbox_id: WEBCHAT.inbox, version: 1, settings: { appearance: { brand_name: 'Northwind Growth' } }, business_hours: {}, allowed_domains: ['northwind.example.com'], changed_by: MEMBER.maya, diff: { created: true }, at: iso(now - 75 * D), created_at: iso(now - 75 * D) },
    { inbox_id: WEBCHAT.inbox, version: 2, settings, business_hours: businessHours, allowed_domains: domains, changed_by: MEMBER.sam, diff: { settings: { appearance: { brand_name: 'Northwind' }, ai: { mode: 'first' }, voice: { enabled: true } }, ai_enabled: true, allowed_domains: domains }, at: iso(now - 2 * D), created_at: iso(now - 2 * D) },
  ]);

  // canned replies (workspace-wide; one personal for Maya)
  const canned: Array<[string, string, string | null]> = [
    ['hi', 'Hi {{contact.first_name}}, {{agent.name}} here from Northwind. Happy to help!', null],
    ['pricing', 'Plans start at $99 a month per sender, with a 14-day trial. Want me to walk you through which plan fits your team?', null],
    ['demo', 'You can pick a time for a 20-minute demo here: https://example.com/book/northwind', null],
    ['hours', 'Our team is online Monday to Friday, 8am–8pm Eastern, and Saturday 10am–4pm.', null],
    ['thanks', 'Thanks for reaching out, {{contact.first_name}}! Anything else I can help with?', null],
    ['followup', 'I will check with the team and get back to you by email today. — {{agent.name}}', MEMBER.maya],
  ];
  canned.forEach(([short_code, content, owner_id], i) => s.insert('outreach_webchat_canned_responses', { workspace_id: DEMO_WS_ID, owner_id, short_code, content, created_by: MEMBER.maya, created_at: iso(now - (60 - i * 5) * D), updated_at: iso(now - (60 - i * 5) * D) }));

  s.insert('outreach_webchat_campaigns', {
    inbox_id: WEBCHAT.inbox, title: 'Pricing page nudge', message: 'Comparing plans? I can tell you which one fits your team in 30 seconds.', sender_kind: 'bot', sender_user_id: null,
    quick_replies: ['Which plan fits us?', 'Book a demo'], rules: { url_rules: [{ op: 'contains', value: '/pricing', action: 'show' }], time_on_page_s: 15, visitor: 'all', business_hours_only: false },
    frequency: 'once', display: 'popup', enabled: true, shown: 214, clicked: 41, started: 17, created_at: iso(now - 40 * D), updated_at: iso(now - 12 * D),
  });

  // anonymous visitors of the last 30 days (no conversation); no spam or bot visitors in the tour
  const countries: Array<[string, string, string]> = [['US', 'Austin', 'America/Chicago'], ['US', 'Brooklyn', 'America/New_York'], ['GB', 'Leeds', 'Europe/London'], ['CA', 'Toronto', 'America/Toronto'], ['DE', 'Hamburg', 'Europe/Berlin'], ['IN', 'Pune', 'Asia/Kolkata'], ['AU', 'Perth', 'Australia/Perth']];
  const pages = ['/', '/pricing', '/services/linkedin-outreach', '/blog/cold-email-benchmarks', '/case-studies', '/contact'];
  for (let i = 0; i < 36; i++) {
    const [country, city, timezone] = s.pick(countries);
    const first = now - s.int(1, 29 * 24) * 3_600_000, last = Math.min(now - 10 * M, first + s.int(0, 72) * 3_600_000);
    const page = s.pick(pages);
    s.insert('outreach_webchat_visitors', {
      workspace_id: DEMO_WS_ID, inbox_id: WEBCHAT.inbox, identifier: null, identity_verified: false, name: null, email: null, email_verified: false, email_invalid: false, phone: null, avatar_url: null,
      company: null, lead_id: null, custom_attributes: {}, consent: null, ip_hash: hex(s, 16), country, city, timezone, browser: s.pick(['Chrome', 'Safari', 'Edge', 'Firefox']), os: s.pick(['macOS', 'Windows', 'iOS', 'Android']),
      device: s.chance(0.3) ? 'mobile' : 'desktop', locale: 'en', referrer: s.pick([null, 'https://www.example.com/search', 'https://news.example.com/']), landing_url: `https://northwind.example.com${page}`, utm: null,
      current_url: `https://northwind.example.com${s.pick(pages)}`, current_title: 'Northwind Growth', current_at: iso(last), token_version: 1, first_seen_at: iso(first), last_seen_at: iso(last),
      blocked_at: null, merged_into: null, voice_consent_at: null, created_at: iso(first),
    });
  }

  // voice: both agents synced; the sample call (the inbox seed may show it as a card in one of its website chats)
  for (const which of ['live', 'test']) {
    s.insert('outreach_webchat_voice_agents', { inbox_id: WEBCHAT.inbox, which, workspace_id: DEMO_WS_ID, account: 'platform', el_agent_id: `demo-agent-${which}-northwind`, synced_at: iso(now - 2 * D), sync_error: null,
      sync_attempts: 0, archived: false, draft: null, draft_at: which === 'test' ? iso(now - 2 * D) : null, updated_at: iso(now - 2 * D) });
  }
  const inbox = s.get('outreach_webchat_inboxes', WEBCHAT.inbox)!;
  const turns = sampleTurns(s, inbox, 'en');
  const duration = Math.round(turns.reduce((n, t) => n + turnSeconds(t) + (t.role === 'tool' ? 0.1 : 0.55), 0.4));
  const started = now - 26 * 3_600_000;
  s.insert('outreach_webchat_voice_calls', {
    id: SAMPLE_VOICE_CALL_ID, workspace_id: DEMO_WS_ID, inbox_id: WEBCHAT.inbox, chat_id: null, visitor_id: null, el_conversation_id: 'demo-conv-sample-1', el_agent_id: 'demo-agent-live-northwind',
    account: 'platform', test: false, status: 'done', started_at: iso(started), ended_at: iso(started + duration * 1000), ended_reason: 'agent_end_call', duration_s: duration, cost_credits: null, cost_usd: null,
    language: 'en', summary: 'Jordan asked how Northwind works and for a gift idea under budget, then asked for a callback tomorrow. The assistant answered, suggested two products and saved the phone number.',
    title: 'Callback request after a pricing question', successful: 'success', collected: { visitor_name: 'Jordan', visitor_phone: '+1 555 0142', need: 'A callback tomorrow' },
    tool_calls: turns.filter((t) => t.role === 'tool').length, empty_searches: 0, has_audio: true, handoff_reason: null, max_minutes: 5, agent_turns: turns.filter((t) => t.role === 'agent').length,
    low_next: false, page_url: 'https://northwind.example.com/pricing', card_message_id: null, started_by: null, finalized_at: iso(started + duration * 1000 + 2 * M), poll_attempts: 0, next_poll_at: null,
  });
  // the spoken answers are assistant turns like the written ones (Reports: "Asked by voice")
  turns.forEach((t, i) => {
    if (t.role !== 'agent' || i === 0) return;
    const q = [...turns.slice(0, i)].reverse().find((x) => x.role === 'user');
    s.insert('outreach_webchat_ai_turns', { workspace_id: DEMO_WS_ID, inbox_id: WEBCHAT.inbox, chat_id: null, visitor_id: null, question_message_id: null, answer_message_id: null, query: q?.text ?? '',
      answer: t.text, sources: [], confidence: 'high', handoff: null, page_url: 'https://northwind.example.com/pricing', tokens_in: null, tokens_out: null, latency_ms: 900 + i * 40, feedback: null,
      feedback_text: null, model: 'demo', products: [], context: null, product_id: null, product_search: null, voice_call_id: SAMPLE_VOICE_CALL_ID, created_at: iso(started + i * 8000) });
  });
}
