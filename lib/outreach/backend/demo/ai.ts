/**
 * Local "AI" for the demo (docs/outreach/PRODUCT-TOUR.md §4.5). No model is called: believable output built from the
 * demo data with fixed sentence templates and the store's seeded randomness. Every caller labels the result as sample
 * output. Owned by the AI area; other areas use these functions as they are.
 */
import type { DemoStore, Row } from './store';

export const SAMPLE_AI_TAG = 'Sample AI output';

function firstName(store: DemoStore, senderId: string | null | undefined): string {
  const s = senderId ? store.get('outreach_senders', senderId) : undefined;
  return String(s?.display_name ?? 'Maya').split(' ')[0];
}

/** A personalised first line for a lead, with the profile facts it relied on (the review table shows them). */
export function personalLine(store: DemoStore, leadId: string): { text: string; facts: Array<{ label: string; value: string }> } {
  const lead = store.get('outreach_leads', leadId) ?? {};
  const p = store.get('outreach_lead_profiles', leadId, 'lead_id');
  const post: Row | undefined = Array.isArray(p?.posts) ? p.posts[0] : undefined;
  const facts: Array<{ label: string; value: string }> = [];
  let text: string;
  if (post?.text) {
    const topic = String(post.text).replace(/^Some thoughts on /, '').replace(/\. What has worked.*$/, '');
    facts.push({ label: 'Recent post', value: String(post.text).slice(0, 120) });
    text = `Your post on ${topic} was a good read`;
  } else if (p?.current_started_on) {
    const months = Math.max(1, Math.round((Date.now() - Date.parse(p.current_started_on)) / (30.44 * 86_400_000)));
    facts.push({ label: 'Time in role', value: `${months} months as ${lead.title ?? 'leader'}` });
    text = months < 18 ? `Congrats on the first ${months} months as ${lead.title ?? 'a leader'} at ${lead.company ?? 'the company'}` : `Impressive run at ${lead.company ?? 'your company'} over the last ${Math.round(months / 12)} years`;
  } else if (p?.education?.[0]?.school) {
    facts.push({ label: 'School', value: p.education[0].school });
    text = `Fellow ${p.education[0].school} alum here, always good to meet one`;
  } else {
    facts.push({ label: 'Company', value: String(lead.company ?? '') });
    text = `Saw what ${lead.company ?? 'your team'} is building and wanted to say hello`;
  }
  if (lead.company) facts.push({ label: 'Company', value: String(lead.company) });
  return { text, facts };
}

/** Rule-based values for a Fields variable (choice, yes/no, number, text) from the lead's profile. */
export function fieldValues(store: DemoStore, leadId: string, fields: Array<{ key: string; type: string; options?: string[] }>): Record<string, string | number | boolean | null> {
  const lead = store.get('outreach_leads', leadId) ?? {};
  const p = store.get('outreach_lead_profiles', leadId, 'lead_id');
  const h = [...leadId].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const out: Record<string, string | number | boolean | null> = {};
  for (const f of fields) {
    if (f.type === 'choice') out[f.key] = f.options?.length ? f.options[h % f.options.length] : null;
    else if (f.type === 'yes_no') out[f.key] = /founder|ceo|owner|vp|head|chief|director/i.test(String(lead.title ?? '')) ? true : (h % 3 === 0);
    else if (f.type === 'number') out[f.key] = p?.connections_count ?? (h % 500);
    else out[f.key] = `${lead.title ?? 'Leader'} at ${lead.company ?? 'their company'}`;
  }
  return out;
}

export type DraftIntent = 'interested' | 'question' | 'not_now' | 'not_interested' | 'ooo' | 'wrong_person' | 'unclear' | 'unclassified' | string | null;

/** A reply draft for the last inbound message of a conversation. */
export function draftReply(store: DemoStore, chat: Row, opts: { intent?: DraftIntent; lastText?: string | null } = {}): string {
  const lead = chat.lead_id ? store.get('outreach_leads', chat.lead_id) : undefined;
  const name = String(lead?.first_name ?? chat.attendee_name ?? 'there').split(' ')[0];
  const me = firstName(store, chat.sender_id);
  const intent = opts.intent ?? chat.intent;
  switch (intent) {
    case 'interested': return `Thanks ${name}, great to hear! Here is my calendar so you can pick a time that suits you: https://example.com/book/northwind. Looking forward to it. ${me}`;
    case 'question': return `Good question, ${name}. In short: it runs LinkedIn and email from one place, with safe daily limits per account, and replies land in one inbox. Happy to show you in 15 minutes this week?`;
    case 'not_now': return `Totally understand, ${name}. I will check back in a couple of months. If anything changes before then, just reply here.`;
    case 'not_interested': return `Thanks for letting me know, ${name}. I will not follow up. All the best with ${lead?.company ?? 'everything'}!`;
    case 'ooo': return `Hi ${name}, no rush at all. I will follow up when you are back.`;
    case 'wrong_person': return `Thanks ${name}, appreciate the pointer. Who would be the best person to speak to about this?`;
    default: return `Thanks for the reply, ${name}! Would a quick call later this week work for you?`;
  }
}

/** Website agent: the best seeded Q&A answer for a question (keyword overlap), or a polite fallback. */
export function websiteAnswer(store: DemoStore, question: string, qa: Array<{ question: string; answer: string }>): { answer: string; matched: boolean } {
  const words = new Set(question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  let best: { score: number; answer: string } | null = null;
  for (const x of qa) {
    const score = x.question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { score, answer: x.answer };
  }
  void store;
  return best ? { answer: best.answer, matched: true } : { answer: 'Good question! I do not have that in my notes yet, so I will pass it to the team and they will get back to you by email.', matched: false };
}
