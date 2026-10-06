/*
 * Reply alerts service worker (reply-notifications-PRD.md §4.1, §7). Registered by the outreach app with scope /outreach/.
 *
 * It shows desktop notifications — for the open app (the alerting tab posts {type:'gx-alert-show'}) and for Web Push when
 * no tab is open — and handles their clicks. It caches nothing and intercepts no requests: there is no fetch handler,
 * on purpose. One notification per conversation (tag = conversation); more than 5 conversations within 60 s collapse
 * into one "6 new replies" notification. The page and the push path use the same tags, so a reply never shows twice.
 */
'use strict';

const ICON = '/android-chrome-192x192.png';
const SUMMARY_TAG = 'gx-replies-summary';
const REPLY_KINDS = ['reply_new', 'webchat_message'];
const SUMMARY_AFTER = 5;
const SUMMARY_WINDOW_MS = 60 * 1000;

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

const tagFor = (d) => (d.chat_id ? `gx-chat-${d.chat_id}` : `gx-${d.id || 'alert'}`);
const keyFor = (d) => `${d.id || ''}|${d.at || ''}|${d.count || 1}`;

function hiddenText(d) {
  switch (d.kind) {
    case 'reply_new': return `New reply on ${d.channel || 'LinkedIn'}`;
    case 'webchat_message': return 'New website chat message';
    case 'note_mention': return 'New mention in a private note';
    case 'ai_handoff': return 'A conversation was handed to you';
    case 'assigned': return 'A conversation was assigned to you';
    default: return 'New activity';
  }
}

/** Body: "3 new messages", their words (first 120 characters), then "LinkedIn · to Naman · Workspace". */
function compose(d) {
  const lines = [];
  if (d.preview === false) lines.push(hiddenText(d));
  else {
    if ((d.count || 1) > 1 && REPLY_KINDS.includes(d.kind)) lines.push(`${d.count} new messages`);
    if (d.text) lines.push(String(d.text).slice(0, 120));
  }
  const meta = [d.channel, d.to ? `to ${d.to}` : null, d.ws_name].filter(Boolean).join(' · ');
  if (meta) lines.push(meta);
  return lines.join('\n');
}

function urlFor(d) {
  if (d.url) return d.url;
  if (!d.chat_id) return '/outreach/inbox';
  const q = new URLSearchParams();
  if (d.note_id) q.set('note', d.note_id);
  else if (d.message_id) q.set('m', d.message_id);
  if (d.ws) q.set('ws', d.ws);
  const qs = q.toString();
  return `/outreach/inbox/${d.chat_id}${qs ? `?${qs}` : ''}`;
}

/**
 * Show (or update) the notification for one alert.
 *   silent  no sound from the notification itself (the page plays the app's sound, or the person turned sound off)
 *   update  a merged message inside 30 s: refresh the text without alerting again
 */
async function showAlert(d, opts) {
  const reg = self.registration;
  const tag = tagFor(d);
  const key = keyFor(d);
  const now = Date.now();
  const existing = await reg.getNotifications({ tag });
  // the page and a push can both deliver the same alert: the second one is a no-op
  if (existing.some((n) => n.data && n.data.key === key)) return;
  if (opts.update && existing.length === 0) return;   // nothing on screen to refresh

  if (REPLY_KINDS.includes(d.kind) && !opts.update && existing.length === 0) {
    const all = await reg.getNotifications();
    const summary = all.find((n) => n.tag === SUMMARY_TAG && n.data && now - n.data.updated_at < SUMMARY_WINDOW_MS);
    if (summary) {
      const chats = Array.from(new Set([...(summary.data.chats || []), d.chat_id]));
      await reg.showNotification(`${chats.length} new replies`, {
        tag: SUMMARY_TAG, body: 'Open Replies → Needs reply', icon: ICON, badge: ICON, silent: true, renotify: false,
        data: { gx: true, kind: 'summary', chats, url: '/outreach/inbox?chip=needs_reply', shown_at: summary.data.shown_at, updated_at: now },
      });
      return;
    }
    const recent = all.filter((n) => n.data && n.data.gx && REPLY_KINDS.includes(n.data.kind) && now - n.data.shown_at < SUMMARY_WINDOW_MS);
    if (recent.length + 1 > SUMMARY_AFTER) {
      const chats = Array.from(new Set([...recent.map((n) => n.data.chat_id), d.chat_id]));
      recent.forEach((n) => n.close());
      await reg.showNotification(`${chats.length} new replies`, {
        tag: SUMMARY_TAG, body: 'Open Replies → Needs reply', icon: ICON, badge: ICON, silent: !!opts.silent,
        data: { gx: true, kind: 'summary', chats, url: '/outreach/inbox?chip=needs_reply', shown_at: now, updated_at: now },
      });
      return;
    }
  }

  const shownAt = existing[0] && existing[0].data && opts.update ? existing[0].data.shown_at : now;
  await reg.showNotification(d.title || 'New reply', {
    tag, body: compose(d), icon: ICON, badge: ICON,
    silent: !!opts.silent || !!opts.update,
    renotify: existing.length > 0 && !opts.update,
    timestamp: d.at ? Date.parse(d.at) || now : now,
    data: { gx: true, key, id: d.id, kind: d.kind, chat_id: d.chat_id || null, ws: d.ws || null, url: urlFor(d), shown_at: shownAt },
  });
}

async function closeChat(chatId) {
  const list = await self.registration.getNotifications({ tag: `gx-chat-${chatId}` });
  list.forEach((n) => n.close());
}

async function appWindows() {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return wins.filter((c) => { try { return new URL(c.url).pathname.startsWith('/outreach'); } catch { return false; } });
}

self.addEventListener('message', (event) => {
  const m = event.data || {};
  if (m.type === 'gx-alert-show' && m.data) event.waitUntil(showAlert(m.data, { silent: !!m.silent, update: !!m.update }));
  else if (m.type === 'gx-alert-clear' && m.chat_id) event.waitUntil(closeChat(m.chat_id));
  else if (m.type === 'gx-alert-test') {
    event.waitUntil(self.registration.showNotification(m.title || "You're set. Replies will show up like this.", {
      tag: 'gx-test', body: m.body || 'Priya Nair · Razorpay\nSure, happy to chat next week.', icon: ICON, badge: ICON, silent: !!m.silent, renotify: true,
      data: { gx: true, kind: 'test', url: '/outreach/settings/notifications', shown_at: Date.now() },
    }));
  }
});

// Web Push (step 2). A visible, focused app tab handles the alert itself (§3.3); an app open only in the background gets
// a silent notification (that tab plays the sound); with no tab open the operating system's sound plays, unless the
// person's Sound tick is off for this kind.
self.addEventListener('push', (event) => {
  let d = null;
  try { d = event.data ? event.data.json() : null; } catch { d = null; }
  event.waitUntil((async () => {
    if (!d || d.v !== 1) {
      await self.registration.showNotification('New activity in your inbox', { tag: 'gx-generic', icon: ICON, badge: ICON, data: { gx: true, kind: 'generic', url: '/outreach/inbox', shown_at: Date.now() } });
      return;
    }
    const wins = await appWindows();
    if (wins.some((c) => c.focused && c.visibilityState === 'visible')) return;
    await showAlert(d, { silent: wins.length > 0 || d.sound === false });
  })());
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = n.data || {};
  const url = data.url || '/outreach/inbox';
  n.close();
  event.waitUntil((async () => {
    const wins = await appWindows();
    const target = wins.find((c) => c.focused) || wins.find((c) => c.visibilityState === 'visible') || wins[0];
    if (target) {
      try { await target.focus(); } catch { /* focus can be refused; navigation still happens */ }
      target.postMessage({ type: 'gx-alert-open', url, id: data.id || null, chat_id: data.chat_id || null, ws: data.ws || null });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
