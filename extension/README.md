# CapitalxAI Outreach Session Sync (Chrome extension)

A tiny Manifest V3 extension (plain JavaScript, no build step) that keeps a LinkedIn **sender** connected to CapitalxAI Outreach. When LinkedIn ends the session Unipile holds for a sender, the backend can reconnect it silently using the session cookie this extension syncs — instead of asking the account holder to log in again.

It is installed **by the person who owns the LinkedIn account**, in the Chrome profile where they are logged in to LinkedIn.

## What it does

* Every 3 hours, and whenever the LinkedIn `li_at` / `li_a` cookie changes (debounced ~1 minute), it:
  1. reads the `li_at` (and `li_a`, premium only) cookies for `linkedin.com`,
  2. resolves which member is logged in (`plainId` + `publicIdentifier`),
  3. POSTs `{li_at, li_a, user_agent, plain_id, public_identifier}` to `<functions base>/outreach-cookie-sync` with `Authorization: Bearer <pairing token>`.
* The backend verifies the pairing token, checks that the logged-in member **is the sender's own account** (otherwise `409 E_IDENTITY_MISMATCH`), encrypts the cookie (AES-256-GCM) and, if the sender is currently disconnected, triggers a reconnect immediately.
* The toolbar badge shows the last result:

  | Badge | Meaning |
  |---|---|
  | `OK` (green) | last sync accepted |
  | `!` (red) | identity mismatch (wrong LinkedIn account in this browser), rejected token, sender disabled, or a network/server error — open the popup for details |
  | `OUT` (grey) | no LinkedIn session in this browser profile (logged out) |
  | none | no pairing token saved yet |

The backend accepts one sync per sender every 10 minutes; the extension backs off accordingly (and for 10 minutes after a `429`).

## Install (unpacked, for beta)

1. Open `chrome://extensions` in Chrome (or Edge: `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension (puzzle icon → pin) so the badge is visible.

## Pair it with a sender

1. In CapitalxAI Outreach open **Senders → (the sender) → Extension** tab.
2. Click **Generate pairing token**. The token is shown **once**; generating a new one invalidates the previous one. (Managers and owners can do this.)
3. Click the extension icon, paste the token into **Pairing token**, click **Save**, then **Sync now**.
4. The popup shows the sender name returned by the backend and the status `Synced`.

Make sure the Chrome profile is logged in to LinkedIn **as that sender**. If a different LinkedIn account is logged in, the backend refuses the cookie with *Wrong LinkedIn account* and nothing is stored.

**Advanced → Functions base URL** only needs changing for a self-hosted / staging backend. Default: `https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1`.

## Privacy

* The extension reads only LinkedIn cookies (`li_at`, `li_a`, and `JSESSIONID` to identify the logged-in member). It does not read browsing history, page content, or cookies of any other site.
* Cookies are sent **only** to your workspace's backend (the functions base URL above) over HTTPS, authenticated with your per-sender pairing token. They are never sent to LinkedIn on your behalf by the extension, and never to third parties.
* On the backend the cookie is stored **encrypted at rest** (AES-256-GCM, key held only by the edge functions), every read is logged, and it is used solely to re-establish the Unipile session for *your* sender.
* You stay in control: logging out of LinkedIn invalidates the session cookie everywhere, which revokes what the backend holds. Removing the extension stops all syncing; a workspace manager can rotate or purge the stored secret from the sender page.
* This platform is not affiliated with LinkedIn. Automating LinkedIn activity may breach LinkedIn's User Agreement; the account holder bears the restriction risk.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest: `cookies`, `alarms`, `storage`; host permission `https://www.linkedin.com/*` |
| `background.js` | service worker: alarms, cookie change listener, sync + badge |
| `popup.html` / `popup.js` | pairing token + base URL form, *Sync now*, last status |
| `icons/` | 16 / 48 / 128 px icons |

## Troubleshooting

* **Token rejected (401)** — generate a fresh pairing token; each sender has exactly one valid token.
* **Wrong LinkedIn account (409)** — log out of LinkedIn and log in as the sender, then *Sync now*.
* **Rate limited (429)** — wait 10 minutes; automatic syncs already respect this.
* **Sender disabled (404)** — the sender was disabled in the workspace; re-enable/reconnect from the app.
* **Logged out (OUT)** — log in to LinkedIn in this Chrome profile; the sync fires automatically when the cookie appears.
