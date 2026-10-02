/**
 * Face photos for the demo's people (public/faces, 160px WebP, ~2.5 KB): w01-w09 / m01-m07 are the marketing site's
 * licensed stock portraits, w10-w16 / m08-m11 were added for the tour with the same crop (face box = middle half).
 * Senders each get their own face; about half of the leads get one from the faces no sender uses, the rest keep their
 * initials. Faces are handed out in inbox order (latest conversation first, then newest lead), so the first screens of the
 * inbox and the leads table rarely show the same face twice.
 */
import type { DemoStore } from '../store';
import { FEMALE_FIRST_NAMES, MALE_FIRST_NAMES } from './names';

const face = (id: string) => `/faces/${id}.webp`;

/** Sender display name → face. */
export const SENDER_FACES: Record<string, string> = {
  'Maya Chen': face('w08'), 'Sam Okafor': face('m03'), 'Priya Lindqvist': face('w05'), 'Leo Moreau': face('m02'), 'Nadia Haddad': face('w01'),
};

const LEAD_FACES = {
  f: ['w02', 'w03', 'w04', 'w06', 'w07', 'w09', 'w10', 'w11', 'w12', 'w13', 'w14', 'w15', 'w16'].map(face),
  m: ['m01', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10', 'm11'].map(face),
};

/** About half of the leads, picked by id (first names alternate woman / man, so every other row would pick one gender). */
const hasPhoto = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2 === 0;

/** Runs last: sets lead photos and copies them onto the lead's conversations. */
export function seedFaces(s: DemoStore) {
  const lastChat = new Map<string, string>();
  for (const c of s.t('outreach_chats')) {
    if (c.lead_id && (c.last_message_at ?? '') > (lastChat.get(c.lead_id) ?? '')) lastChat.set(c.lead_id, c.last_message_at);
  }
  const leads = [...s.t('outreach_leads')].sort((a, b) => (lastChat.get(b.id) ?? '').localeCompare(lastChat.get(a.id) ?? '') || String(b.created_at).localeCompare(String(a.created_at)));
  const next = { f: 0, m: 0 };
  const photo = new Map<string, string>();
  for (const l of leads) {
    if (l.picture_url || !hasPhoto(l.id)) continue;
    const g = FEMALE_FIRST_NAMES.has(l.first_name) ? 'f' : MALE_FIRST_NAMES.has(l.first_name) ? 'm' : null;
    if (!g) continue;
    l.picture_url = LEAD_FACES[g][next[g]++ % LEAD_FACES[g].length];
    photo.set(l.id, l.picture_url);
  }
  for (const c of s.t('outreach_chats')) if (c.lead_id && !c.attendee_picture_url && photo.has(c.lead_id)) c.attendee_picture_url = photo.get(c.lead_id);
}
