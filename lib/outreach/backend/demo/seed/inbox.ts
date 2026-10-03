/**
 * Demo seed: WhatsApp, Instagram and website conversations, more recent replies on the history's threads, triage state
 * (read / unread, assignment, snooze, labels), private notes with @mentions, and the notifications they made.
 * Runs after the 60-day history and the webchat seed. Fictional people only; every time is relative to `now`.
 */
import { DEMO_TOUR_AI_CHAT_ID } from '../../../demoIds';
import { SAMPLE_AI_TAG } from '../ai';
import { DEMO_MODEL } from '../aihub/jobs';
import { AI_IDS } from '../aihub/knowledge';
import { addMessage, catalogueProducts, insertNote, mentionToken, productCard, productItem, type MessageInput } from '../inbox/shared';
import { engineFor, type Engine } from '../sim/engine';
import type { DemoStore, Row } from '../store';
import { CLIENT, DEMO_USER_ID, DEMO_WS_ID, MEMBER, SENDER, WEBCHAT, leadId } from './ids';

const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const MAIL = new Set(['GMAIL', 'OUTLOOK', 'IMAP']);

const NAMES: Record<string, string> = { [MEMBER.maya]: 'Maya Chen', [MEMBER.sam]: 'Sam Okafor', [MEMBER.priya]: 'Priya Lindqvist', [MEMBER.leo]: 'Leo Moreau' };
const mention = (user: string) => mentionToken(NAMES[user], user);

type Line = Omit<MessageInput, 'at'> & { ago: number };

function play(s: DemoStore, chat: Row, now: number, lines: Line[]): Row[] {
  return lines.map(({ ago, ...m }) => addMessage(s, chat, { ...m, at: now - ago }));
}

/** Lead bookkeeping after an inbound message on a messaging channel. */
function touchLead(s: DemoStore, engine: Engine, chat: Row, channel: string) {
  const msgs = s.t('outreach_messages').filter((m) => m.chat_id === chat.id);
  const lastIn = msgs.filter((m) => m.direction === 'in').map((m) => m.sent_at).sort().pop();
  const lastOut = msgs.filter((m) => m.direction === 'out').map((m) => m.sent_at).sort().pop();
  const st = engine.state(chat.lead_id, chat.sender_id);
  s.update('outreach_lead_sender_state', (r) => r === st, { relation: 'first', last_inbound_at: lastIn ?? null, last_outbound_at: lastOut ?? null, replied: !!lastIn, unipile_chat_id: chat.unipile_chat_id }, { silent: true });
  const lead = s.get('outreach_leads', chat.lead_id);
  if (lead && lastIn && (!lead.last_replied_at || lead.last_replied_at < lastIn)) s.update('outreach_leads', lead.id, { last_replied_at: lastIn, last_replied_channel: channel }, { silent: true });
}

// ------------------------------------------------------------------------------------------------ WhatsApp
function seedWhatsApp(s: DemoStore, now: number, engine: Engine): Row[] {
  const sender = s.get('outreach_senders', SENDER.whatsapp);
  if (!sender) return [];
  const out: Row[] = [];
  const specs: Array<{ i: number; basis: string; note: string; lines: (first: string) => Line[]; assign?: string; labels?: string[] }> = [
    {
      i: 12, basis: 'inbound', note: 'Wrote to the WhatsApp number from the meetup slide', labels: ['pilot'],
      lines: (first) => [
        { direction: 'in', text: 'Hi! Saw your session at the growth meetup. Do you also handle WhatsApp follow-ups for event leads?', ago: 5 * D + 2 * H, read: true },
        { direction: 'out', text: `Hi ${first}! Yes, event leads are a big one for us. LinkedIn, email and WhatsApp follow-ups all run from one place, and replies land in one inbox.`, ago: 5 * D + H, origin: 'inbox_user', sent_by: MEMBER.maya, read_at: iso(now - 5 * D) },
        { direction: 'in', text: null, ago: 4 * D + 3 * H, read: true, attachments: [{ id: 'wa-voice-1', name: 'voice-note.ogg', type: 'audio', mimetype: 'audio/ogg', voice_note: true, duration_s: 14 }], transcript: 'Quick question. Could we try it with two of our reps first before we roll it out to the whole team?', transcript_status: 'done', intent: 'question', summary: 'Asked about a two-seat pilot.' },
        { direction: 'out', text: 'Absolutely, a two-seat pilot works well. I will put together a short plan with what to measure in the first two weeks.', ago: 4 * D + 2 * H, origin: 'inbox_user', sent_by: MEMBER.maya, read_at: iso(now - 4 * D - H), reactions: [{ emoji: '👍', by: first, mine: false, at: iso(now - 4 * D - H) }] },
        { direction: 'in', text: 'Here is how our follow-up works today, so you can see where it breaks.', ago: 3 * H, attachments: [{ id: 'wa-img-1', name: 'follow-up-flow.png', type: 'image', mimetype: 'image/png', size: 48_210 }], intent: 'interested', summary: 'Shared their current process; ready for the pilot plan.' },
      ],
    },
    {
      i: 48, basis: 'form_optin', note: 'Webinar sign-up form: "Send me the recording on WhatsApp"', assign: MEMBER.sam,
      lines: (first) => [
        { direction: 'out', text: `Hi ${first}, thanks for joining the webinar! Here is the recording as promised: https://example.com/webinar/recording`, ago: 2 * D + 5 * H, origin: 'inbox_user', sent_by: MEMBER.sam, read_at: iso(now - 2 * D - 4 * H) },
        { direction: 'in', text: 'Thanks Sam! Really useful session. Could we book a quick call on Thursday?', ago: D + 6 * H, read: true, intent: 'interested', summary: 'Wants a call on Thursday.' },
        { direction: 'out', text: 'Thursday at 3pm works. Sending the invite now, talk soon!', ago: D + 5 * H, origin: 'inbox_user', sent_by: MEMBER.sam, read_at: iso(now - D - 5 * H) },
      ],
    },
    {
      i: 96, basis: 'explicit_share', note: 'Shared the number in a LinkedIn message',
      lines: (first) => [
        { direction: 'out', text: `Hi ${first}, Maya here from Northwind. Following up from our LinkedIn chat, happy to continue here.`, ago: 6 * D + 4 * H, origin: 'inbox_user', sent_by: MEMBER.maya, read_at: iso(now - 6 * D - 3 * H) },
        { direction: 'in', text: 'Sure, WhatsApp is easier for me during the week.', ago: 6 * D + 2 * H, read: true },
        { direction: 'out', text: 'Great. I sent the one-page proposal by email. The short version: two LinkedIn accounts, one mailbox, setup done for you in the first week.', ago: 6 * D + H, origin: 'inbox_user', sent_by: MEMBER.maya, read_at: iso(now - 5 * D) },
        { direction: 'in', text: 'Let me check with my cofounder and get back to you next week.', ago: 20 * H, intent: 'not_now', summary: 'Needs to check with the cofounder; follow up next week.' },
      ],
    },
  ];
  for (const sp of specs) {
    const lead = s.get('outreach_leads', leadId(sp.i));
    if (!lead) continue;
    const ident = s.t('outreach_lead_identities').find((x) => x.lead_id === lead.id && x.provider === 'WHATSAPP');
    const phone = String(ident?.identifier ?? `+1555010${String(sp.i % 100).padStart(2, '0')}`);
    if (ident) s.update('outreach_lead_identities', ident.id, { verified: true, is_valid: true, last_checked_at: iso(now - 7 * D) }, { silent: true });
    if (!s.t('outreach_lead_consent').some((c) => c.lead_id === lead.id && c.channel === 'WHATSAPP' && !c.revoked_at)) {
      s.insert('outreach_lead_consent', { workspace_id: DEMO_WS_ID, lead_id: lead.id, channel: 'WHATSAPP', basis: sp.basis, evidence: { note: sp.note }, attested_by: MEMBER.maya, obtained_at: iso(now - 8 * D), expires_at: null, revoked_at: null, revoked_reason: null, created_at: iso(now - 8 * D) });
    }
    const chat = engine.ensureChat(lead, sender, now - 9 * D);
    s.update('outreach_chats', chat.id, { attendee_provider_id: `${phone.replace(/\D/g, '')}@s.whatsapp.net`, attendee_public_identifier: phone, assigned_to: sp.assign ?? null, labels: sp.labels ?? [] });
    play(s, chat, now, sp.lines(lead.first_name));
    touchLead(s, engine, chat, 'whatsapp');
    out.push(chat);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ Instagram
function seedInstagram(s: DemoStore, now: number, engine: Engine): Row[] {
  const sender = s.get('outreach_senders', SENDER.instagram);
  if (!sender) return [];
  const out: Row[] = [];
  const specs: Array<{ i: number; request?: boolean; lines: (first: string) => Line[] }> = [
    {
      i: 23, request: true,
      lines: () => [
        { direction: 'in', text: 'Hey! Love your posts on outbound. Do you work with small agencies or only bigger teams?', ago: 7 * H, intent: 'question', summary: 'Asked whether small agencies are a fit.' },
      ],
    },
    {
      i: 53,
      lines: (first) => [
        // a reply to our story, a shared post and an emoji-only message: drawn the way Instagram draws them
        { direction: 'in', text: 'Ha, this is exactly our team every Monday 😂', ago: 3 * D + 6 * H, read: true, content_attributes: { msg_type: 'STORY_REPLY' }, attachments: [{ id: 'ig-story-1', name: 'story.png', type: 'img', mimetype: 'image/png' }], preview: 'Replied to your story' },
        { direction: 'out', text: `Thanks for the follow, ${first}! Saw you are building out the sales team at your company. Happy to share what has worked for teams your size.`, ago: 3 * D + 2 * H, origin: 'inbox_user', sent_by: MEMBER.priya, read_at: iso(now - 3 * D) },
        { direction: 'in', text: 'Would love to see a demo 🙌', ago: 2 * D + 5 * H, read: true, intent: 'interested', summary: 'Asked for a demo.' },
        { direction: 'out', text: 'Here is a short walkthrough, and my calendar if you want to talk it through: https://example.com/book/northwind', ago: 2 * D + 4 * H, origin: 'inbox_user', sent_by: MEMBER.priya, read_at: iso(now - 2 * D - 3 * H) },
        { direction: 'in', text: null, ago: 2 * D + 3 * H, read: true, preview: 'Shared a post', attachments: [{ id: 'ig-post-1', name: 'post.png', type: 'img', mimetype: 'image/png', link: { url: 'https://www.instagram.com/p/DEMO0outbound/', author: 'growth.weekly', text: '5 cold DM openers that actually get replies' } }] },
        { direction: 'in', text: '🔥🔥', ago: 2 * D + 3 * H - M, read: true },
        { direction: 'out', text: 'That one is from our weekly teardown 😄 Glad it helped!', ago: 2 * D + 2 * H, origin: 'inbox_user', sent_by: MEMBER.priya, read_at: iso(now - 2 * D - H), reactions: [{ emoji: '❤️', by: first, mine: false, at: iso(now - 2 * D - H) }] },
        { direction: 'in', text: 'Booked for Monday. See you then!', ago: 5 * H, reactions: [] },
      ],
    },
    {
      i: 113,
      lines: (first) => [
        { direction: 'in', text: 'Is this the team behind the cold email teardown series?', ago: 4 * D + 6 * H, read: true, intent: 'unclear' },
        { direction: 'out', text: `That is us, ${first}! A new teardown goes out every Tuesday.`, ago: 4 * D + 5 * H, origin: 'inbox_user', sent_by: MEMBER.maya, read_at: iso(now - 4 * D - 4 * H), reactions: [{ emoji: '❤️', by: first, mine: false, at: iso(now - 4 * D - 4 * H) }] },
        { direction: 'in', text: 'Nice, following. The one on subject lines was great.', ago: 3 * D + 20 * H, read: true },
      ],
    },
  ];
  for (const sp of specs) {
    const lead = s.get('outreach_leads', leadId(sp.i));
    if (!lead) continue;
    let ident = s.t('outreach_lead_identities').find((x) => x.lead_id === lead.id && x.provider === 'INSTAGRAM');
    if (!ident) ident = s.insert('outreach_lead_identities', { workspace_id: DEMO_WS_ID, lead_id: lead.id, provider: 'INSTAGRAM', identifier: `${String(lead.first_name).toLowerCase()}.${String(lead.last_name).toLowerCase()}.demo`, provider_id: null, verified: true, source: 'manual', is_valid: true, last_checked_at: null, created_at: iso(now - 10 * D) }, { silent: true })[0];
    const chat = engine.ensureChat(lead, sender, now - 8 * D);
    s.update('outreach_chats', chat.id, { attendee_provider_id: `ig-demo-${sp.i}`, attendee_public_identifier: ident.identifier, is_request: !!sp.request });
    play(s, chat, now, sp.lines(lead.first_name));
    touchLead(s, engine, chat, 'instagram');
    out.push(chat);
  }
  return out;
}

/** A lead with no conversation on this sender yet, so a showcase thread starts clean. */
function freshLead(s: DemoStore, senderId: string, from: number): Row | undefined {
  const busy = new Set(s.t('outreach_chats').filter((c) => c.sender_id === senderId).map((c) => c.lead_id));
  for (let i = from; i < from + 200; i++) {
    const l = s.get('outreach_leads', leadId(i));
    if (l && !busy.has(l.id) && !l.do_not_contact && !l.unsubscribed && l.first_name && l.company) return l;
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------ email (a mail client's thread)
/** A six-mail thread: a Cc'd colleague who answers too, quoted history, attachments, opens and clicks. */
function seedEmailShowcase(s: DemoStore, now: number, engine: Engine): Row[] {
  const sender = s.get('outreach_senders', SENDER.gmail);
  const lead = sender ? freshLead(s, sender.id, 150) : undefined;
  if (!sender || !lead) return [];
  const first = String(lead.first_name);
  const domain = `${String(lead.company).toLowerCase().replace(/[^a-z0-9]+/g, '')}.example.com`;
  const leadEmail = String(lead.email_work ?? `${first.toLowerCase()}@${domain}`).toLowerCase();
  if (!lead.email_work) s.update('outreach_leads', lead.id, { email_work: leadEmail }, { silent: true });
  const me = { name: 'Maya Chen', email: String(sender.owner_email ?? 'maya@northwind.example.com') };
  const them = { name: String(lead.full_name), email: leadEmail };
  const daniel = { name: 'Daniel Brooks', email: `daniel.brooks@${domain}` };
  const subject = `Outbound pilot for ${lead.company}`;
  const head = (from: Row, to: Row[], cc: Row[] = [], subj = `Re: ${subject}`) => ({ email: { from, to, cc, bcc: [], reply_to: [], subject: subj } });
  const when = (ms: number) => new Date(now - ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const sig = '<p>Maya Chen<br/>Northwind Growth</p>';
  const first1 = `<p>Hi ${first},</p><p>I noticed ${lead.company} is growing the sales team this quarter. We run LinkedIn, email and WhatsApp follow-ups from one place, so new reps start with warm conversations instead of cold lists.</p><p>Would a two-week pilot with two of your reps be useful? Here is how other teams set it up: <a href="https://example.com/pilot">example.com/pilot</a></p>${sig}`;
  const quote = (ms: number, who: Row, html: string) => `<div class="gmail_quote"><div class="gmail_attr">On ${when(ms)}, ${who.name} &lt;${who.email}&gt; wrote:</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${html}</blockquote></div>`;
  const reply2 = `<p>Thanks for being so quick, ${first}.</p><p>Good to meet you, Daniel. The pilot is two weeks, two seats, and we do the setup. I will send the plan with what we measure in the first week.</p>${sig}`;
  const daniel4 = `<p>Hi Maya,</p><p>Here are our numbers from last quarter and how the team is split today. The big gap is follow-up after events: most leads never get a second touch.</p><p>Best,<br/>Daniel</p>`;
  const chat = engine.ensureChat(lead, sender, now - 10 * D, subject);
  s.update('outreach_chats', chat.id, { attendee_provider_id: leadEmail, attendee_public_identifier: leadEmail, attendee_name: them.name, subject });
  play(s, chat, now, [
    { direction: 'out', text: null, html: first1, ago: 9 * D, origin: 'sequence', opens: 4, content_attributes: head(me, [them], [], subject), preview: `Hi ${first}, I noticed ${lead.company} is growing the sales team` },
    { direction: 'in', text: `Hi Maya,\n\nThis is timely, we are hiring two SDRs. Adding Daniel, who runs sales ops.\n\nWhat would the pilot need from our side?\n\n${first}\n\nOn ${when(9 * D)}, Maya Chen <${me.email}> wrote:\n> Hi ${first},\n> I noticed ${lead.company} is growing the sales team this quarter.`, ago: 8 * D + 3 * H, read: true, intent: 'interested', summary: 'Hiring two SDRs; looped in sales ops; asked what the pilot needs.', content_attributes: head(them, [me], [daniel]) },
    { direction: 'out', text: null, html: reply2 + quote(8 * D + 3 * H, them, `<p>This is timely, we are hiring two SDRs. Adding Daniel, who runs sales ops.</p>`), ago: 8 * D + H, origin: 'inbox_user', sent_by: MEMBER.maya, opens: 2, content_attributes: head(me, [them], [daniel]), preview: `Thanks for being so quick, ${first}.` },
    { direction: 'in', text: null, html: daniel4 + `<blockquote type="cite">${reply2}</blockquote>`, ago: 6 * D + 2 * H, read: true, sender_name: daniel.name, content_attributes: head(daniel, [me], [them]), preview: 'Here are our numbers from last quarter', attachments: [{ id: 'mail-xlsx-1', name: 'Q3-outbound-numbers.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 48_120, email: true }, { id: 'mail-pdf-1', name: 'team-structure.pdf', type: 'application/pdf', mimetype: 'application/pdf', size: 212_400, email: true }, { id: 'mail-png-1', name: 'follow-up-gaps.png', type: 'image/png', mimetype: 'image/png', size: 64_900, email: true }] },
    { direction: 'out', text: null, html: `<p>Thanks Daniel, this is really helpful. The event follow-up gap is exactly what the pilot fixes first.</p><p>Plan attached in the next mail once ${first} is happy with the dates.</p>${sig}`, ago: 5 * D + 4 * H, origin: 'inbox_user', sent_by: MEMBER.maya, opens: 3, content_attributes: head(me, [daniel], [them]), preview: 'Thanks Daniel, this is really helpful.' },
    { direction: 'in', text: null, html: `<p>Looks good to both of us. Can you send the agreement? Our signed NDA is attached.</p><p>${first}</p>` + quote(5 * D + 4 * H, me, `<p>Thanks Daniel, this is really helpful.</p>`), ago: 2 * H, intent: 'interested', summary: 'Ready to sign; asked for the agreement and sent a signed NDA.', content_attributes: head(them, [me], [daniel]), preview: 'Looks good to both of us. Can you send the agreement?', attachments: [{ id: 'mail-pdf-2', name: 'Mutual-NDA-signed.pdf', type: 'application/pdf', mimetype: 'application/pdf', size: 98_300, email: true }] },
  ]);
  const firstMail = s.t('outreach_messages').find((m) => m.chat_id === chat.id && m.direction === 'out');
  if (firstMail) s.update('outreach_messages', firstMail.id, { clicks: 1 }, { silent: true });
  touchLead(s, engine, chat, 'email');
  return [chat];
}

// ------------------------------------------------------------------------------------------------ LinkedIn (InMail, post share, video meeting)
function seedLinkedInShowcase(s: DemoStore, now: number, engine: Engine): Row[] {
  const sender = s.get('outreach_senders', SENDER.li_maya);
  const lead = sender ? freshLead(s, sender.id, 170) : undefined;
  if (!sender || !lead) return [];
  const first = String(lead.first_name);
  s.update('outreach_leads', lead.id, { linkedin: { ...(lead.linkedin ?? {}), network_distance: 'SECOND_DEGREE', is_premium: true, is_open_profile: true } }, { silent: true });
  const chat = engine.ensureChat(lead, sender, now - 7 * D);
  s.update('outreach_chats', chat.id, { custom_attributes: { linkedin: { content_type: 'inmail', inbox: 'sales_navigator' } } });
  const meetAt = new Date(now + 2 * D);
  meetAt.setHours(15, 0, 0, 0);
  play(s, chat, now, [
    { direction: 'out', text: `Hi ${first}, congrats on the new role! I help sales leaders at companies like ${lead.company} turn event leads into booked calls without adding headcount. Open to comparing notes?`, ago: 6 * D, origin: 'sequence', read_at: iso(now - 5 * D), content_attributes: { msg_type: 'INMAIL', subject: `Quick idea for ${lead.company}` } },
    { direction: 'in', text: null, ago: 5 * D - 10 * M, read: true, content_attributes: { msg_type: 'INMAIL_ACCEPT' }, preview: 'Accepted your InMail' },
    { direction: 'in', text: 'Thanks Maya! Timing is good, we are hiring two SDRs this quarter.', ago: 5 * D - 11 * M, read: true, intent: 'interested', summary: 'Hiring two SDRs; open to talk.' },
    { direction: 'in', text: 'What does onboarding look like on your side?', ago: 5 * D - 12 * M, read: true },
    { direction: 'out', text: 'Setup is done for you in the first week. Here is a post with what a recent team saw in month one:', ago: 4 * D + 20 * H, origin: 'inbox_user', sent_by: MEMBER.maya, read_at: iso(now - 4 * D), attachments: [{ id: 'li-post-1', name: 'LinkedIn post', type: 'linkedin_post', link: { url: 'https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000001/', author: null, text: null } }] },
    { direction: 'out', text: 'Would a 20-minute call next week work?', ago: 4 * D + 20 * H - M, origin: 'inbox_user', sent_by: MEMBER.maya, read_at: iso(now - 4 * D) },
    { direction: 'in', text: 'Sure, I sent you an invite for Thursday.', ago: 3 * D, read: true, intent: 'interested', summary: 'Sent a video meeting invite for Thursday.', attachments: [{ id: 'li-meet-1', name: 'Video meeting', type: 'video_meeting', meeting: { starts_at: meetAt.toISOString(), expires_at: new Date(meetAt.getTime() + 30 * M).toISOString(), url: 'https://example.com/meet/northwind-demo' } }] },
    { direction: 'out', text: 'Perfect, see you then 👍', ago: 3 * D - 30 * M, origin: 'inbox_user', sent_by: MEMBER.maya, read_at: iso(now - 2 * D), reactions: [{ emoji: '👍', by: first, mine: false, at: iso(now - 2 * D) }] },
  ]);
  touchLead(s, engine, chat, 'linkedin');
  return [chat];
}

// ------------------------------------------------------------------------------------------------ LinkedIn: the AI books a call
/**
 * The walkthrough's "AI handles the replies" thread (fixed id): the prospect asks two questions, AI Auto Replies answers
 * from the default prompt's facts and sends the calendar link, the prospect books, Maya confirms.
 */
function seedAiBookedShowcase(s: DemoStore, now: number, engine: Engine): Row[] {
  const sender = s.get('outreach_senders', SENDER.li_maya);
  // not another "Maya": the thread reads as two people
  let lead = sender ? freshLead(s, sender.id, 260) : undefined;
  for (let i = 261; sender && lead && lead.first_name === 'Maya' && i < 300; i++) lead = freshLead(s, sender.id, i);
  if (!sender || !lead) return [];
  const first = String(lead.first_name);
  const company = String(lead.company);
  const chat = engine.ensureChat(lead, sender, now - 4 * D, null, DEMO_TOUR_AI_CHAT_ID);
  const [, ask1, ai1, ask2, ai2] = play(s, chat, now, [
    { direction: 'out', text: `Hi ${first}, saw ${company} is growing the sales team. We help B2B teams book first meetings on LinkedIn and email without hiring more SDRs. Worth a quick chat?`, ago: 3 * D + 4 * H, origin: 'sequence', read_at: iso(now - 3 * D) },
    { direction: 'in', text: 'Maybe. How is this different from an SDR agency?', ago: 2 * D + 6 * H, read: true, intent: 'question', summary: 'Asked how it differs from an SDR agency.' },
    { direction: 'out', text: 'Good question. An agency writes from their own accounts. We run outreach from your team\'s LinkedIn and email, and every reply comes back to one inbox. Teams usually see 8–15% replies in the first month.', ago: 2 * D + 6 * H - 4 * M, origin: 'ai_autopilot', read_at: iso(now - 2 * D - 5 * H) },
    { direction: 'in', text: 'Interesting. What would it cost for three people?', ago: 2 * D + 3 * H, read: true, intent: 'question', summary: 'Asked about pricing for three people.' },
    { direction: 'out', text: `Plans start at $99 per sender a month, so about $297 for three, with a 14-day free trial. Happy to show you how it would work for ${company}. Pick a time here: https://example.com/book/northwind`, ago: 2 * D + 3 * H - 5 * M, origin: 'ai_autopilot', read_at: iso(now - 2 * D - 2 * H) },
    { direction: 'in', text: 'Booked Thursday at 11. Looking forward to it.', ago: D + 2 * H, read: true, intent: 'interested', summary: 'Booked a call for Thursday at 11.' },
    { direction: 'out', text: `Thanks ${first}, see you Thursday! I will bring a short plan for ${company}.`, ago: D + H, origin: 'inbox_user', sent_by: MEMBER.maya, read_at: iso(now - D) },
  ]);
  const mp = s.get('outreach_master_prompts', AI_IDS.mpLibrary);
  const run = (inbound: Row, msg: Row, o: { stage: [string, string]; move: string; rule: string; facts: Array<[string, string]>; stop?: boolean }) => s.insert('outreach_ai_reply_runs', {
    workspace_id: chat.workspace_id, client_id: chat.client_id ?? null, chat_id: chat.id, sender_id: chat.sender_id, lead_id: lead.id, sequence_id: null, provider: chat.provider,
    inbound_message_ids: [inbound.id], followup_inbound_ids: [], debounce_until: inbound.sent_at, debounce_hard_until: inbound.sent_at, attempts: 1, send_attempts: 1, next_attempt_at: null,
    mode: 'autopilot', policy_snapshot: { mode: 'autopilot', delay_min_s: 180, delay_max_s: 300 }, master_prompt_id: mp?.id ?? null, master_prompt_version: mp?.version ?? null,
    floor_sha256: null, model: DEMO_MODEL, status: 'sent', decision: 'send', intent: inbound.intent, flags: [], language: 'en', stage_before: o.stage[0], stage_after: o.stage[1],
    move: o.move, rule_applied: o.rule, side_effects: [], draft_confidence: 0.93, draft_text: msg.text, final_text: msg.text, facts_used: o.facts.map(([claim, source]) => ({ claim, source })),
    validator: { ok: true }, verifier: { supported: true, unsupported_claims: [], follows_rule: true, answers_their_questions: true }, redrafts: 0, gate_failures: [], escalation_reasons: [],
    context: { lead: { name: lead.full_name, title: lead.title, company } }, scheduled_send_at: msg.sent_at, sent_message_id: msg.id, action_id: null, sent_origin: 'ai_autopilot',
    dispatched_by: null, cancelled_by: null, cancel_reason: null, cancel_note: null, edit_distance: 0, facts_changed: false,
    reply_latency_s: Math.round((Date.parse(msg.sent_at) - Date.parse(inbound.sent_at)) / 1000), drew_bot_question: false, drew_hostile: false, error: null,
    timings: { inbound_at: inbound.sent_at, drafted_at: inbound.sent_at, sent_at: msg.sent_at }, trigger_kind: 'auto', requested_by: null, requested_via: null, guidance: null, variants: null,
    stop_after_send: !!o.stop, stop_rule: o.stop ? 'Calendar link sent' : null, scenario_id: null, gap_days: null, session_kind: 'normal', warnings: [],
    created_at: inbound.sent_at, updated_at: msg.sent_at,
  })[0];
  const r1 = run(ask1, ai1, { stage: ['engage', 'relate'], move: 'answer', rule: 'Answer the question, then one line of proof', facts: [['Teams usually see 8–15% replies in the first month', 'master_prompt.facts']] });
  const r2 = run(ask2, ai2, { stage: ['pitch', 'next_step'], move: 'schedule', rule: 'Pricing asked: give the starting price, then offer the calendar', facts: [['Plans from $99 per sender per month', 'master_prompt.facts'], ['14-day free trial', 'master_prompt.facts'], ['Calendar: https://example.com/book/northwind', 'master_prompt.facts']], stop: true });
  s.update('outreach_messages', ai1.id, { ai_reply_run_id: r1.id }, { silent: true });
  s.update('outreach_messages', ai2.id, { ai_reply_run_id: r2.id }, { silent: true });
  s.update('outreach_chats', chat.id, {
    ai_replies_count: 2, last_ai_move: 'schedule', conversation_stage: 'next_step', ai_run_id: r2.id, ai_run_status: 'sent', ai_run_decision: 'send', ai_session_started_at: ask1.sent_at, ai_session_kind: 'normal',
    ai_handed_off_at: ai2.sent_at, ai_handoff_reason: 'calendar_sent', ai_handoff_rule: 'Calendar link sent', ai_handoff_run_id: r2.id, labels: ['meeting booked'], assigned_to: MEMBER.maya,
  }, { silent: true });
  touchLead(s, engine, chat, 'linkedin');
  return [chat];
}

// ------------------------------------------------------------------------------------------------ fresher replies on history threads
/** The history's replies are spread over 60 days; a few prospects answered in the last week, and the team wrote back. */
function seedRecentReplies(s: DemoStore, now: number, engine: Engine): Row[] {
  const lastOf = new Map<string, Row>();
  const hasIn = new Set<string>();
  for (const m of s.t('outreach_messages')) {
    if (m.direction === 'in') hasIn.add(m.chat_id);
    const cur = lastOf.get(m.chat_id);
    if (!cur || cur.sent_at < m.sent_at) lastOf.set(m.chat_id, m);
  }
  const candidates = s.t('outreach_chats')
    .filter((c) => !c.webchat_inbox_id && c.lead_id && ['LINKEDIN', 'GMAIL', 'OUTLOOK'].includes(c.provider) && !hasIn.has(c.id) && lastOf.get(c.id)?.direction === 'out')
    .filter((c) => { const l = s.get('outreach_leads', c.lead_id); return l && !l.do_not_contact && !l.unsubscribed; })
    .filter((c) => now - Date.parse(lastOf.get(c.id)!.sent_at) < 25 * D && now - Date.parse(lastOf.get(c.id)!.sent_at) > 8 * H)
    .sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)));
  const picked: Row[] = [];
  const step = Math.max(1, Math.floor(candidates.length / 9));
  for (let k = 0; k < candidates.length && picked.length < 9; k += step) picked.push(candidates[k]);
  const team = [MEMBER.maya, MEMBER.sam, MEMBER.priya];
  picked.forEach((c, k) => {
    const last = lastOf.get(c.id)!;
    const lastMs = Date.parse(last.sent_at);
    // replies land between the last message and now, mostly in the last few days
    const at = Math.min(now - (30 + k * 37) * M, Math.max(lastMs + 2 * H, now - (1 + k * 0.6) * D));
    engine.deliverReply({ chat_id: c.id, lead_id: c.lead_id, sender_id: c.sender_id, action_id: last.action_id ?? null }, at);
    if (k % 2 === 1 && at < now - 4 * H) {
      const lead = s.get('outreach_leads', c.lead_id);
      const first = String(lead?.first_name ?? 'there');
      const who = team[k % team.length];
      const text = MAIL.has(c.provider)
        ? `Hi ${first},\n\nThanks for getting back to me. Happy to walk you through it, does Thursday at 2pm or Friday morning work?\n\nBest,\n${NAMES[who].split(' ')[0]}`
        : `Thanks ${first}! Happy to walk you through it. Does Thursday at 2pm or Friday morning work for a quick call?`;
      addMessage(s, c, { direction: 'out', text, at: at + 50 * M, origin: 'inbox_user', sent_by: who, read_at: c.provider === 'LINKEDIN' ? iso(at + 2 * H) : null });
      if (k % 4 === 1 && at + 3 * H < now - 20 * M) engine.deliverReply({ chat_id: c.id, lead_id: c.lead_id, sender_id: c.sender_id, follow_up: true }, at + 3 * H);
    }
  });
  return picked;
}

// ------------------------------------------------------------------------------------------------ website chats
type Visitor = { name: string | null; email: string | null; company: string | null; country: string; city: string; tz: string; browser: string; os: string; device: string; pages: Array<[string, string]>; referrer: string | null; utm?: Row; lead?: string | null };

function addVisitor(s: DemoStore, inbox: Row, v: Visitor, firstMs: number, lastMs: number): Row {
  const site = 'https://northwind.example.com';
  const row = s.insert('outreach_webchat_visitors', {
    workspace_id: DEMO_WS_ID, inbox_id: inbox.id, identifier: null, identity_verified: false, name: v.name, email: v.email, email_verified: !!v.email, email_invalid: false,
    phone: null, avatar_url: null, company: v.company, lead_id: v.lead ?? null, custom_attributes: {}, consent: null, ip_hash: 'demo', country: v.country, city: v.city, timezone: v.tz,
    browser: v.browser, os: v.os, device: v.device, locale: 'en-US', referrer: v.referrer, landing_url: `${site}${v.pages[0][0]}`, utm: v.utm ?? null,
    current_url: `${site}${v.pages[v.pages.length - 1][0]}`, current_title: v.pages[v.pages.length - 1][1], current_at: iso(lastMs), token_version: 1,
    first_seen_at: iso(firstMs), last_seen_at: iso(lastMs), blocked_at: null, merged_into: null, created_at: iso(firstMs),
  })[0];
  v.pages.forEach(([path, title], k) => s.insert('outreach_webchat_page_views', { visitor_id: row.id, url: `${site}${path}`, title, referrer: k === 0 ? v.referrer : null, utm: k === 0 ? (v.utm ?? null) : null, at: iso(firstMs + k * 3 * M) }, { silent: true }));
  return row;
}

function webchatChatRow(s: DemoStore, inbox: Row, sender: Row, visitor: Row, createdMs: number, extra: Row): Row {
  const id = s.uid();
  return s.insert('outreach_chats', {
    id, workspace_id: DEMO_WS_ID, client_id: inbox.client_id ?? null, sender_id: sender.id, lead_id: visitor.lead_id ?? null, unipile_chat_id: `webchat:${id}`, provider: 'WEBCHAT',
    attendee_provider_id: visitor.id, attendee_public_identifier: visitor.email ?? null, attendee_name: visitor.name ?? 'Visitor', attendee_picture_url: null, subject: null,
    last_message_at: null, last_message_preview: null, last_direction: null, unread: false, unread_count: 0, assigned_to: null, intent: 'unclassified', archived: false, is_request: false,
    last_note_at: null, status: 'open', snoozed_until: null, priority: null, labels: [], custom_attributes: {}, csat: null, ai_handled: true, handed_off_at: null, handoff_reason: null,
    first_response_at: iso(createdMs + 20_000), resolved_at: null, resolved_by: null, source: 'launcher', webchat_inbox_id: inbox.id, visitor_id: visitor.id, voice_calls: 0,
    visitor_last_seen_at: iso(createdMs), visitor_typing_at: null, visitor_typing_text: null, agent_typing_at: null, agent_typing_by: null, ai_mode: 'first', continuity_stopped: false,
    last_continuity_email_at: null, autopilot_state: 'active', conversation_stage: null, conversation_exchanges: 0, ai_replies_count: 0, ai_run_id: null, ai_run_status: null,
    ai_run_decision: null, reply_sequence_id: null, ai_handed_off_at: null, created_at: iso(createdMs), ...extra,
  })[0];
}

const visitorSays = (text: string | null, ago: number, o: Partial<Line> = {}): Line => ({ direction: 'in', text, ago, sender_type: 'visitor', source: 'widget', ...o });
const botSays = (text: string, ago: number, o: Partial<Line> = {}): Line => ({ direction: 'out', text, ago, sender_type: 'bot', sender_name: 'Assistant', source: 'bot', origin: 'ai_autopilot', ...o });

/** AI turns for the assistant's answers (the website's activity and report read them). */
function addTurns(s: DemoStore, chat: Row, msgs: Row[], page: string, extra: Record<number, Row> = {}) {
  for (let k = 0; k < msgs.length; k++) {
    const a = msgs[k];
    if (a.sender_type !== 'bot') continue;
    const q = [...msgs.slice(0, k)].reverse().find((m) => m.direction === 'in');
    if (!q) continue;
    const turn = s.insert('outreach_webchat_ai_turns', {
      workspace_id: DEMO_WS_ID, inbox_id: chat.webchat_inbox_id, chat_id: chat.id, visitor_id: chat.visitor_id, question_message_id: q.id, answer_message_id: a.id,
      query: q.text ?? '', answer: a.text, sources: [{ url: page, title: 'Pricing and plans' }], confidence: 'high', handoff: null, page_url: page,
      tokens_in: 900 + k * 40, tokens_out: 120 + k * 10, latency_ms: 1400 + k * 90, feedback: null, feedback_text: null, model: 'demo', created_at: a.sent_at, ...(extra[k] ?? {}),
    })[0];
    s.update('outreach_messages', a.id, (m) => ({ content_attributes: { ...(m.content_attributes ?? {}), ai: { sources: turn.sources, turn_id: turn.id, tag: SAMPLE_AI_TAG } } }), { silent: true });
  }
}

export function seedWebchatChats(s: DemoStore, now: number): Row[] {
  const sender = s.get('outreach_senders', WEBCHAT.sender);
  const inbox = s.get('outreach_webchat_inboxes', WEBCHAT.inbox) ?? s.t('outreach_webchat_inboxes').find((i) => i.sender_id === WEBCHAT.sender && !i.deleted_at);
  if (!sender || !inbox) return [];
  const site = 'https://northwind.example.com';
  const out: Row[] = [];

  // 1. product recommendations (cards), the visitor still on the site and waiting
  {
    const v = addVisitor(s, inbox, { name: 'Hana Kowalski', email: 'hana.kowalski@example.com', company: 'Driftwood Robotics', country: 'DE', city: 'Berlin', tz: 'Europe/Berlin', browser: 'Chrome', os: 'macOS', device: 'desktop', pages: [['/', 'Northwind Growth'], ['/pricing', 'Pricing and plans']], referrer: 'https://search.example.com/', utm: { utm_source: 'newsletter', utm_campaign: 'october' } }, now - 2 * H, now - 3 * M);
    const chat = webchatChatRow(s, inbox, sender, v, now - 100 * M, { labels: ['pricing'], visitor_last_seen_at: iso(now - 2 * M), visitor_typing_at: null });
    const picks = catalogueProducts(s, DEMO_WS_ID).slice(0, 3);
    const msgs = play(s, chat, now, [
      visitorSays('Hi! We are a team of three just getting started with outbound. What would you recommend?', 100 * M, { read_by_agent_at: iso(now - 99 * M), read: true }),
      botSays('Here are a few picks that fit a small team getting started:', 99 * M, { text: 'Here are a few picks that fit a small team getting started:', content_type: 'cards', content_attributes: { items: picks.map((p) => productItem(p.row)), products: picks.map((p) => productCard(p.row, p.provider)) }, read_by_visitor_at: iso(now - 98 * M) }),
      visitorSays('Does the middle one include an email inbox as well?', 60 * M, { read_by_agent_at: iso(now - 59 * M), read: true }),
      botSays('Yes. Every plan includes at least one mailbox, and replies from LinkedIn and email land in the same inbox.', 59 * M, { read_by_visitor_at: iso(now - 58 * M) }),
      visitorSays('Great, can someone walk me through onboarding?', 25 * M),
    ]);
    addTurns(s, chat, msgs, `${site}/pricing`);
    s.insert('outreach_webchat_events', { visitor_id: v.id, chat_id: chat.id, name: 'product_click', props: { title: picks[1]?.row.title ?? 'Plan' }, at: iso(now - 70 * M) }, { silent: true });
    out.push(chat);
  }

  // 2. a voice call with the assistant (the call card + spoken turns), resolved with a rating
  {
    const lead = s.get('outreach_leads', leadId(31));
    const v = addVisitor(s, inbox, { name: 'Theo Brennan', email: 'theo.brennan@example.com', company: 'Juniper Grid', country: 'US', city: 'Denver', tz: 'America/Denver', browser: 'Safari', os: 'iOS', device: 'mobile', pages: [['/features/limits', 'Safe daily limits'], ['/pricing', 'Pricing and plans']], referrer: null, lead: lead?.id ?? null }, now - 27 * H, now - 25 * H);
    const start = now - 26 * H;
    const chat = webchatChatRow(s, inbox, sender, v, start, { source: 'voice', voice_calls: 1, status: 'resolved', resolved_at: iso(start + 9 * M), resolved_by: 'visitor', csat: { rating: 5, comment: 'Quick and clear answers.', at: iso(start + 10 * M) }, visitor_last_seen_at: iso(start + 9 * M) });
    const callId = s.uid();
    const card = addMessage(s, chat, {
      direction: 'out', text: null, at: start, content_type: 'event', sender_type: 'system', source: 'system', origin: 'ai_autopilot',
      content_attributes: { kind: 'voice_call', call_id: callId, status: 'ended', started_at: iso(start), ended_at: iso(start + 142_000), ended_reason: 'switch', duration_s: 142, title: 'Questions about daily limits', summary: 'Theo asked how the daily LinkedIn limits work and whether replies from every account land in one inbox. The assistant explained the limits and offered a demo.', successful: 'success', has_audio: true, language: 'en', confirmed: true },
    });
    const voice = { voice: { live: false } };
    const msgs = play(s, chat, now, [
      visitorSays('How do the daily limits work for LinkedIn?', 26 * H - 20_000, { content_attributes: voice, read: true, read_by_agent_at: iso(start + 5 * M) }),
      botSays('Each account gets safe daily limits for invitations, messages and profile visits, and new accounts warm up over a few weeks.', 26 * H - 40_000, { content_attributes: voice }),
      visitorSays('And do the replies from all accounts show up in one place?', 26 * H - 80_000, { content_attributes: voice, read: true, read_by_agent_at: iso(start + 5 * M) }),
      botSays('Yes, every reply lands in one inbox, with the account it came through. Would you like to book a short demo?', 26 * H - 110_000, { content_attributes: voice }),
      visitorSays('Thanks, that was helpful. I will book a demo from the pricing page.', 26 * H - 4 * M, { read: true, read_by_agent_at: iso(start + 5 * M) }),
    ]);
    addTurns(s, chat, msgs, `${site}/features/limits`);
    if (!s.get('outreach_webchat_voice_calls', callId)) {
      s.insert('outreach_webchat_voice_calls', {
        id: callId, workspace_id: DEMO_WS_ID, inbox_id: inbox.id, chat_id: chat.id, visitor_id: v.id, el_conversation_id: `demo-conv-${callId.slice(0, 8)}`, el_agent_id: 'demo-voice-agent',
        account: 'platform', test: false, status: 'done', started_at: iso(start), ended_at: iso(start + 142_000), ended_reason: 'switch', duration_s: 142, cost_credits: 3, cost_usd: 0.21,
        language: 'en', summary: card.content_attributes.summary, title: card.content_attributes.title, successful: 'success', collected: {}, tool_calls: 1, empty_searches: 0, has_audio: true,
        handoff_reason: null, max_minutes: 5, agent_turns: 2, low_next: false, page_url: `${site}/features/limits`, card_message_id: card.id, started_by: null, finalized_at: iso(start + 6 * M),
        poll_attempts: 1, next_poll_at: null,
      });
    }
    out.push(chat);
  }

  // 3. handed to a person (pricing for an agency), assigned to Sam, the visitor waiting on a proposal
  {
    const candidate = s.get('outreach_leads', leadId(171));
    const v = addVisitor(s, inbox, { name: 'Clara Mensah', email: candidate?.email_work ?? 'clara.mensah@example.com', company: candidate?.company ?? 'Copperline Studio', country: 'GB', city: 'Manchester', tz: 'Europe/London', browser: 'Firefox', os: 'Windows', device: 'desktop', pages: [['/agencies', 'For agencies'], ['/pricing', 'Pricing and plans'], ['/contact', 'Talk to us']], referrer: 'https://social.example.com/' }, now - 4 * H, now - 35 * M);
    const start = now - 3 * H - 20 * M;
    const chat = webchatChatRow(s, inbox, sender, v, start, { assigned_to: MEMBER.sam, priority: 'high', labels: ['pricing', 'agency'], handed_off_at: iso(start + 2 * M), handoff_reason: 'low_confidence', ai_handled: false, visitor_last_seen_at: iso(now - 35 * M) });
    const msgs = play(s, chat, now, [
      visitorSays('What does it cost for an agency running outreach for 12 client accounts?', 3 * H + 20 * M, { read: true, read_by_agent_at: iso(start + 3 * M) }),
      botSays('Agency pricing depends on how many accounts you connect and whether you want setup help. Let me bring in someone from the team who can give you an exact quote.', 3 * H + 19 * M),
    ]);
    addTurns(s, chat, msgs, `${site}/pricing`, { 1: { confidence: 'low', handoff: 'pricing question' } });
    play(s, chat, now, [
      { direction: 'out', text: null, ago: 3 * H + 18 * M, content_type: 'event', content_attributes: { kind: 'assigned', agent: 'Sam Okafor' }, sender_type: 'system', source: 'system' },
      { direction: 'out', text: 'Hi Clara, Sam here. For 12 client accounts the Agency plan is the best fit: every client gets its own workspace view and reports. I can send a proposal with the numbers today.', ago: 3 * H, origin: 'inbox_user', sent_by: MEMBER.sam, sender_type: 'agent', sender_name: 'Sam Okafor', source: 'agent', read_by_visitor_at: iso(now - 2 * H) },
      visitorSays('That works. Can you send the proposal to my email?', 40 * M),
    ]);
    out.push(chat);
  }

  // 4. snoozed: the visitor asked for a reminder next week
  {
    const v = addVisitor(s, inbox, { name: null, email: null, company: null, country: 'CA', city: 'Toronto', tz: 'America/Toronto', browser: 'Edge', os: 'Windows', device: 'desktop', pages: [['/blog/cold-email-teardown', 'Cold email teardown #12'], ['/features/inbox', 'One inbox']], referrer: 'https://news.example.com/' }, now - 2 * D, now - 2 * D + 20 * M);
    const start = now - 2 * D + 5 * M;
    const chat = webchatChatRow(s, inbox, sender, v, start, { status: 'snoozed', snoozed_until: iso(now + 3 * D), labels: ['follow-up'], visitor_last_seen_at: iso(start + 15 * M) });
    const msgs = play(s, chat, now, [
      visitorSays('Does it sync contacts and replies with our CRM?', 2 * D - 5 * M, { read: true, read_by_agent_at: iso(start + M) }),
      botSays('Yes. Leads, stages and replies sync with your CRM through the built-in integration or a webhook, so your team keeps working where it already is.', 2 * D - 6 * M),
      visitorSays('Nice. We are switching CRMs next week, can you remind me after that?', 2 * D - 12 * M, { read: true, read_by_agent_at: iso(start + 10 * M) }),
      { direction: 'out', text: 'Of course! I will check back with you next week. Good luck with the switch.', ago: 2 * D - 15 * M, origin: 'inbox_user', sent_by: MEMBER.priya, sender_type: 'agent', sender_name: 'Priya Lindqvist', source: 'agent' },
    ]);
    addTurns(s, chat, msgs, `${site}/features/inbox`);
    s.update('outreach_chats', chat.id, { assigned_to: MEMBER.priya });
    out.push(chat);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ triage + notes
function seedTriage(s: DemoStore, now: number, keepUnread: Set<string>): Row[] {
  // older threads were read already: a real inbox has a handful of unread conversations, not every reply
  for (const c of s.t('outreach_chats')) {
    if (keepUnread.has(c.id) || !c.unread) continue;
    if (c.last_message_at && now - Date.parse(c.last_message_at) > 3 * D) s.update('outreach_chats', c.id, { unread: false, unread_count: 0 }, { silent: true });
  }
  const replied = s.t('outreach_chats').filter((c) => !c.webchat_inbox_id && ['LINKEDIN', 'GMAIL', 'OUTLOOK'].includes(c.provider) && c.last_direction === 'in')
    .sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)));
  const plan: Array<[string, string[]]> = [[MEMBER.maya, ['hot-lead']], [MEMBER.priya, ['follow-up']], [MEMBER.maya, []], [MEMBER.sam, ['partner']], [MEMBER.priya, []]];
  const assigned: Row[] = [];
  replied.filter((c) => c.client_id !== CLIENT.orchard).slice(0, plan.length).forEach((c, k) => {
    s.update('outreach_chats', c.id, { assigned_to: plan[k][0], labels: plan[k][1] }, { silent: true });
    assigned.push(c);
  });
  const orchard = replied.find((c) => c.client_id === CLIENT.orchard);
  if (orchard) { s.update('outreach_chats', orchard.id, { assigned_to: MEMBER.leo, labels: ['client: orchard'] }, { silent: true }); assigned.push(orchard); }
  // one "not now" thread snoozed until next week
  const notNow = replied.find((c) => c.intent === 'not_now' && !assigned.includes(c));
  if (notNow) s.update('outreach_chats', notNow.id, { status: 'snoozed', snoozed_until: iso(now + 5 * D), labels: ['check back'] }, { silent: true });
  return assigned;
}

function seedNotes(s: DemoStore, now: number, wa: Row[], web: Row[], assigned: Row[]) {
  const chat = (c: Row | undefined) => (c ? s.get('outreach_chats', c.id) : undefined);
  // 1. Sam mentions the demo user on the WhatsApp pilot thread: unread, it is what the bell shows
  const pilot = chat(wa[0]);
  if (pilot) {
    insertNote(s, pilot, { author_id: MEMBER.sam, author_type: 'user', body: `${mention(DEMO_USER_ID)} they want a two-seat pilot before rolling out. Can you put the pilot plan together before Thursday? I can join the call.`, at: iso(now - 2 * H) });
  }
  // 2. Maya on the agency web chat, mentioning Sam (he read it)
  const agency = chat(web[2]);
  if (agency) {
    insertNote(s, agency, { author_id: MEMBER.maya, author_type: 'user', body: `${mention(MEMBER.sam)} quote the **Agency plan** for 12 accounts and offer setup at half price if they sign this month.`, at: iso(now - 2 * H - 50 * M), mentionsReadAt: iso(now - 2 * H - 30 * M) });
  }
  // 3. Priya on a LinkedIn thread, mentioning the demo user (read a while ago)
  const warm = chat(assigned[0]);
  if (warm) {
    insertNote(s, warm, { author_id: MEMBER.priya, author_type: 'user', body: `Met them at the growth meetup last spring. Warm intro possible through Leo. ${mention(DEMO_USER_ID)} want to take the call?`, at: iso(now - D - 3 * H), mentionsReadAt: iso(now - D) });
  }
  // 4. a note kept away from the AI (#no-ai) on an email thread
  const mail = s.t('outreach_chats').filter((c) => MAIL.has(c.provider) && c.last_direction === 'in').sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)))[0];
  if (mail) insertNote(s, mail, { author_id: MEMBER.maya, author_type: 'user', body: '#no-ai Do not mention pricing until they confirm the budget. Their finance team signs off on anything above 500 a month.', at: iso(now - 3 * D) });
  // 5. an edited note (with its earlier version) on the WhatsApp thread waiting for the cofounder
  const cofounder = chat(wa[2]);
  if (cofounder) {
    const { note } = insertNote(s, cofounder, { author_id: MEMBER.maya, author_type: 'user', body: 'The cofounder decides. Follow up next Tuesday with the one-page proposal and two customer stories.', at: iso(now - 18 * H) });
    s.insert('outreach_chat_note_revisions', { note_id: note.id, revision: 1, body: 'The cofounder decides. Follow up on Monday.', edited_by: MEMBER.maya, edited_at: iso(now - 17 * H) }, { noId: true });
    s.update('outreach_chat_notes', note.id, { edited_at: iso(now - 17 * H) }, { silent: true });
  }
  // 6. the AI's hand-off summary on a LinkedIn thread, with its notification
  const handoff = chat(assigned[2]) ?? chat(assigned[1]);
  if (handoff) {
    const body = 'AI handed off: the lead asked about pricing for a larger team, which the AI does not quote. Their last message is waiting for a person.';
    const { note } = insertNote(s, handoff, { author_id: null, author_type: 'ai', body, at: iso(now - 6 * H) });
    const lead = handoff.lead_id ? s.get('outreach_leads', handoff.lead_id) : undefined;
    s.insert('outreach_notifications', { workspace_id: DEMO_WS_ID, user_id: DEMO_USER_ID, kind: 'ai_handoff', chat_id: handoff.id, note_id: note.id, actor_id: null, title: `AI handed off ${lead?.full_name ?? handoff.attendee_name ?? 'a conversation'}${lead?.company ? ` (${lead.company})` : ''}`, body, read_at: iso(now - 5 * H), created_at: iso(now - 6 * H) });
  }
}

// ------------------------------------------------------------------------------------------------
export function seedInbox(s: DemoStore, now: number): void {
  const engine = engineFor(s);
  const wa = seedWhatsApp(s, now, engine);
  const ig = seedInstagram(s, now, engine);
  const mail = seedEmailShowcase(s, now, engine);
  const li = seedLinkedInShowcase(s, now, engine);
  const booked = seedAiBookedShowcase(s, now, engine);
  const fresh = seedRecentReplies(s, now, engine);
  const web = seedWebchatChats(s, now);
  const keep = new Set([...wa, ...ig, ...mail, ...li, ...booked, ...fresh, ...web].map((c) => c.id));
  const assigned = seedTriage(s, now, keep);
  seedNotes(s, now, wa, web, assigned);
  engine.resetIndexes();
}
