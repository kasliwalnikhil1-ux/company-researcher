/**
 * Face photos for the demo's people (public/faces, 160px WebP, ~2.5 KB): w01-w09 / m01-m07 are the marketing site's
 * licensed stock portraits, w10-w24 / m08-m18 were added for the tour with the same crop (face box = middle half).
 * Every sender and every named person has a face: senders their own, company accounts (WhatsApp, Instagram, website)
 * their owner's, leads one from the faces no sender uses. Seeded leads are handed faces in inbox order (latest
 * conversation first, then newest lead), so neighbouring rows in the inbox and the leads table show different faces.
 * Only anonymous website visitors and bots keep their initials.
 */
import type { DemoStore } from '../store';
import { FEMALE_FIRST_NAMES, MALE_FIRST_NAMES } from './names';

const face = (id: string) => `/faces/${id}.webp`;

/** Sender display name → face. */
export const SENDER_FACES: Record<string, string> = {
  'Maya Chen': face('w08'), 'Sam Okafor': face('m03'), 'Priya Lindqvist': face('w05'), 'Leo Moreau': face('m02'), 'Nadia Haddad': face('w01'),
  'Jess Alvarez': face('w10'), 'Ravi Menon': face('m08'), 'Hannah Vogel': face('w11'), 'Vikram Nair': face('m10'), 'Marta Silva': face('w15'),
};

const LEAD_FACES = {
  f: ['w02', 'w03', 'w04', 'w06', 'w07', 'w09', 'w12', 'w13', 'w14', 'w16', 'w17', 'w18', 'w19', 'w20', 'w21', 'w22', 'w23', 'w24'].map(face),
  m: ['m01', 'm04', 'm05', 'm06', 'm07', 'm09', 'm11', 'm12', 'm13', 'm14', 'm15', 'm16', 'm17', 'm18'].map(face),
};

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** A woman's or a man's face from the first name; a name in neither list gets one picked from `key`. */
const genderOf = (first: unknown, key: string): 'f' | 'm' =>
  FEMALE_FIRST_NAMES.has(String(first)) ? 'f' : MALE_FIRST_NAMES.has(String(first)) ? 'm' : hash(key) % 2 ? 'f' : 'm';

/** A lead's face for a person created while the tour runs (import, CRM sync, website chat): same name, same face. */
export function faceFor(first: unknown, key: string): string {
  const pool = LEAD_FACES[genderOf(first, key)];
  return pool[hash(key) % pool.length];
}

/** A face for someone who is not a lead (a chat with no lead, a website visitor), only when the name is a known first name. */
const namedFace = (name: unknown): string | null => {
  const first = String(name ?? '').trim().split(/\s+/)[0];
  return FEMALE_FIRST_NAMES.has(first) || MALE_FIRST_NAMES.has(first) ? faceFor(first, String(name)) : null;
};

/** Runs last: faces for company senders, every lead, their conversations, and named people with no lead. */
export function seedFaces(s: DemoStore) {
  // company accounts show their owner's photo (Maya runs the WhatsApp number, the Instagram account and the website)
  const memberName = new Map(s.t('outreach_members').map((m) => [m.user_id, m.display_name]));
  for (const x of s.t('outreach_senders')) if (!x.picture_url) x.picture_url = SENDER_FACES[String(memberName.get(x.owner_user_id))] ?? null;

  const lastChat = new Map<string, string>();
  for (const c of s.t('outreach_chats')) {
    if (c.lead_id && (c.last_message_at ?? '') > (lastChat.get(c.lead_id) ?? '')) lastChat.set(c.lead_id, c.last_message_at);
  }
  const leads = [...s.t('outreach_leads')].sort((a, b) => (lastChat.get(b.id) ?? '').localeCompare(lastChat.get(a.id) ?? '') || String(b.created_at).localeCompare(String(a.created_at)));
  const next = { f: 0, m: 0 };
  for (const l of leads) {
    if (l.picture_url) continue;
    const g = genderOf(l.first_name, l.id);
    l.picture_url = LEAD_FACES[g][next[g]++ % LEAD_FACES[g].length];
  }

  const leadFace = new Map(leads.map((l) => [l.id, l.picture_url]));
  for (const c of s.t('outreach_chats')) {
    if (!c.attendee_picture_url) c.attendee_picture_url = (c.lead_id && leadFace.get(c.lead_id)) || namedFace(c.attendee_name);
  }
  for (const v of s.t('outreach_webchat_visitors')) {
    if (!v.avatar_url) v.avatar_url = (v.lead_id && leadFace.get(v.lead_id)) || namedFace(v.name);
  }
}
