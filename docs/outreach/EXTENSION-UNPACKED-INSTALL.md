# Installing the Session Sync extension without the Chrome Web Store

Reader: you own a LinkedIn account that sends through CapitalxAI Outreach. No technical background is needed. Last updated 20 Sep 2026, for extension version 1.0.0.

## Why this guide exists

In August 2026 a competitor's Chrome extension was removed from the Chrome Web Store at LinkedIn's request. Their users now install it by hand. The same could happen to any LinkedIn tool, so we wrote this guide before it is needed.

Two things to know first:

* **The extension is optional.** It does one job: when LinkedIn logs your account out of our service, it lets us reconnect you quietly.
* **The re-login link is a complete fallback.** Without the extension, you get a link, you log in to LinkedIn once on a secure page, and sending resumes. Nothing else changes. If installing the extension is a problem for any reason, skip it and use the link ([see the last section](#if-your-company-blocks-developer-mode)).

## Before you start

You need:

1. **The extension folder.** Your workspace manager sends you a zip file. Unzip it somewhere it can stay, for example `Documents\outreach-extension`. Chrome runs the extension from this folder, so **do not move, rename or delete the folder afterwards**. If you do, the extension stops working.
2. **Chrome or Microsoft Edge on a computer** (not a phone), in the browser profile where you are logged in to LinkedIn **as yourself**.
3. **A pairing token** from your workspace manager, or from the app if you are a manager (step 2 below).

Do not install it on a shared computer.

## Step 1: install the extension

### Chrome

1. Type `chrome://extensions` in the address bar and press Enter.
2. Turn on **Developer mode** with the switch at the top right.
3. Click **Load unpacked**.
4. Select the folder you unzipped. Pick the folder that contains the file `manifest.json`, not the folder above it.
5. "CapitalxAI Outreach Session Sync" appears in the list.
6. Click the puzzle-piece icon in the toolbar and pin the extension, so you can see its badge.

### Microsoft Edge

1. Type `edge://extensions` in the address bar and press Enter.
2. Turn on **Developer mode** in the left-hand panel.
3. Click **Load unpacked** and select the folder that contains `manifest.json`.
4. Click the puzzle-piece icon and show the extension in the toolbar.

Chrome sometimes shows a "Disable developer mode extensions" notice when it starts. Close the notice. Do not click Disable.

## Step 2: pair it with your sender

The pairing token tells our service which sender this browser belongs to.

1. A manager or owner opens **Senders → your sender → Extension** tab in CapitalxAI Outreach and clicks **Generate pairing token**. The token is shown once. Creating a new token cancels the old one.
2. Click the extension icon in your toolbar.
3. Paste the token into **Pairing token**.
4. Click **Save**, then **Sync now**.
5. The popup shows **Synced** and your sender's name. The badge on the icon turns to a green **OK**.

Leave **Advanced → Functions base URL** empty unless your manager gives you a value.

### What the badge means

| Badge | Meaning | What to do |
|---|---|---|
| Green **OK** | The last sync was accepted | Nothing |
| Grey **OUT** | This browser is not logged in to LinkedIn | Log in to LinkedIn. The sync runs on its own |
| Red **!** | Something was refused. Open the popup for the message | See below |
| No badge | No pairing token saved yet | Do step 2 |

| Message in the popup | Cause | Fix |
|---|---|---|
| Wrong LinkedIn account | The browser is logged in to a different LinkedIn account than the sender. Nothing was stored | Log out of LinkedIn, log in as the sender's account, click **Sync now** |
| Token rejected | The token was replaced or mistyped | Ask for a new pairing token |
| Rate limited | The service accepts one sync per sender every 10 minutes | Wait 10 minutes |
| Sender disabled | The sender was disabled in the workspace | Ask your manager |

After pairing you do not need to do anything. The extension syncs every 3 hours, and about a minute after your LinkedIn login changes.

## What the extension reads, and what it does not

This is taken from the extension's code (`manifest.json` and `background.js`), not from a description of it.

**It reads:**

* Three LinkedIn cookies: `li_at` and `li_a` (your LinkedIn login session; `li_a` exists only on premium accounts) and `JSESSIONID` (used once, to ask LinkedIn who is logged in).
* Which LinkedIn member is logged in. To find out, it requests two LinkedIn addresses in the background (`/voyager/api/me`, and `/feed/` as a fallback) and keeps only two values from the answer: your numeric member id and your public profile name (the part after `linkedin.com/in/`).
* Your browser's user-agent string (browser name and version).

**It sends** those values, `li_at`, `li_a`, member id, profile name and user-agent, to one place only: the CapitalxAI Outreach service, over HTTPS, signed with your pairing token. The service checks that the member id belongs to your sender. If it does not, the cookie is refused and not stored. If it does, the cookie is stored encrypted, every later read of it is logged, and it is used only to reconnect your sender.

**It does not:**

* read your LinkedIn messages, connections, feed content or anyone's profile;
* read or change the pages you visit. It has no access to page content at all (the extension contains no content scripts);
* read cookies or data from any site other than `linkedin.com`. Its only site permission is `https://www.linkedin.com/*`;
* read your browsing history, passwords or bookmarks. Its only browser permissions are `cookies`, `alarms` (the 3-hour timer) and `storage` (to remember your token and the last status on your computer);
* send messages, invitations or anything else on LinkedIn. Campaigns run on our servers, not in your browser;
* send anything to third parties.

**You stay in control.** Logging out of LinkedIn ends the session everywhere, which makes the stored cookie useless. Removing the extension stops all syncing. To have the stored cookie deleted, ask your manager: the platform operator can delete it on request, and disabling a sender (sender page, **Danger** tab) purges it as part of the disable.

A note on risk, stated plainly: this service is not affiliated with LinkedIn. Automating LinkedIn activity can breach LinkedIn's User Agreement, and the account holder carries that risk. The extension does not change this either way. It only keeps the connection alive.

## Updating the extension

Extensions installed this way do not update themselves.

1. Your manager sends a new zip file.
2. Unzip it and copy its contents **over the existing folder**, replacing the old files. Keep the folder in the same place with the same name.
3. Open `chrome://extensions` (or `edge://extensions`).
4. Click the round **reload** arrow on the "CapitalxAI Outreach Session Sync" card.
5. Check the version number on the card matches the one your manager told you.

Your pairing token is kept. Click the icon and **Sync now** to confirm it still shows **Synced**.

## Removing the extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Click **Remove** on the "CapitalxAI Outreach Session Sync" card and confirm. This also deletes the pairing token saved in your browser.
3. Delete the folder.
4. Optional: ask your manager to regenerate the pairing token, which cancels the old one, and to have the stored cookie deleted (see "You stay in control" above).

Your sender keeps working. If LinkedIn ends the session later, you will be asked to use the re-login link.

## If your company blocks developer mode

Some companies lock `chrome://extensions` so **Developer mode** or **Load unpacked** is greyed out, or remove unpacked extensions automatically. Do not try to work around your company's policy.

Use the re-login link instead:

1. When LinkedIn ends your session, the sender shows as disconnected in the app, and the workspace owners and managers see it on their dashboard.
2. You receive an email with a **reconnect** link. If email notices are not switched on for your workspace, your manager can create the same link on the sender page (**Send re-login link**), copy it and send it to you.
3. Open the link, log in to LinkedIn on the secure sign-in page, and complete any verification code LinkedIn asks for.
4. The sender reconnects and sending resumes. Leads that failed only because the sender was disconnected are retried automatically.

The only difference from using the extension is that someone has to click a link when a disconnect happens, instead of it being fixed in the background.

## Questions

Ask your workspace manager first. Managers: the operator notes are in [SETUP.md](SETUP.md) (§2.8 and §6.2) and the developer notes in `extension/README.md`.
