'use client';

// Hosted full-page chat (web-chat-PRD.md §5.1 `standalone`): /chat/<website_token>[?resume=<token>]
// Used for link-in-bio / email signatures and as the "Continue the chat" target of continuity emails. The page is just a
// container: the same loader + panel bundle every website embeds mounts here in `embedded` mode, full height.
// No sign-in, no app chrome: the visitor is the audience. Origin checks pass because the app's own origin is always allowed.

import { useEffect, useMemo } from 'react';

declare global { interface Window { growthxaiSettings?: Record<string, unknown>; growthxai?: { destroy?: () => void } } }
import { useParams, useSearchParams } from 'next/navigation';

export default function StandaloneChatPage() {
  const params = useParams<{ token: string }>();
  const search = useSearchParams();
  const token = params?.token ?? '';
  const resume = search?.get('resume') ?? null;
  const api = useMemo(() => `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''}/functions/v1/outreach-webchat`, []);

  useEffect(() => {
    if (!token || !/^[a-f0-9]{16,64}$/i.test(token)) return;
    window.growthxaiSettings = { mode: 'embedded', mountSelector: '#gx-standalone', standalone: true, resume, autoOpen: true };
    const s = document.createElement('script');
    s.src = '/widget/v1/loader.js';
    s.async = true;
    s.dataset.websiteToken = token;
    s.dataset.api = api;
    s.dataset.mountSelector = '#gx-standalone';
    document.body.appendChild(s);
    return () => { try { window.growthxai?.destroy?.(); } catch { /* ignore */ } s.remove(); };
  }, [token, api, resume]);

  return (
    <div style={{ minHeight: '100dvh', background: '#f3f4f6', display: 'flex', justifyContent: 'center' }}>
      <div id="gx-standalone" style={{ width: '100%', maxWidth: 760, minHeight: '100dvh', background: '#fff' }} aria-live="polite" />
      <noscript>This chat needs JavaScript.</noscript>
    </div>
  );
}
