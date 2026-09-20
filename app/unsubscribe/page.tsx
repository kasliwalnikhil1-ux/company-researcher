'use client';

// Public unsubscribe page (no login). Emails link to the outreach-unsubscribe function, which redirects here when
// OUTREACH_UNSUBSCRIBE_PAGE_URL is set (the default *.supabase.co domain serves function HTML as plain text).
// Opening the page never unsubscribes by itself: mail scanners open every link. The button does.
import React, { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const FN = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/functions/v1/outreach-unsubscribe`;

type Brand = { product_name?: string; workspace_name?: string; logo_url?: string; accent?: string; support_email?: string };
type State = 'loading' | 'ready' | 'working' | 'done' | 'invalid' | 'error';

function Inner() {
  const params = useSearchParams();
  const l = params.get('l') ?? '';
  const t = params.get('t') ?? '';
  const [state, setState] = useState<State>('loading');
  const [brand, setBrand] = useState<Brand>({});
  const url = `${FN}?l=${encodeURIComponent(l)}&t=${encodeURIComponent(t)}`;

  useEffect(() => {
    if (!l || !t) { setState('invalid'); return; }
    let cancelled = false;
    fetch(url, { headers: { accept: 'application/json' } })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok) { setState('invalid'); return; }
        setBrand(body.branding ?? {});
        setState(body.unsubscribed ? 'done' : 'ready');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [l, t, url]);

  async function unsubscribe() {
    setState('working');
    try {
      const r = await fetch(url, { method: 'POST', headers: { accept: 'application/json' } });
      setState(r.ok ? 'done' : r.status === 400 ? 'invalid' : 'error');
    } catch { setState('error'); }
  }

  const accent = /^#[0-9a-fA-F]{6}$/.test(brand.accent ?? '') ? brand.accent! : '#1f2937';
  const name = brand.product_name || brand.workspace_name || '';
  const copy: Record<State, { title: string; body: string }> = {
    loading: { title: 'One moment', body: 'Checking your link.' },
    ready: { title: 'Unsubscribe from these emails?', body: 'You will not receive further emails from this sender.' },
    working: { title: 'Unsubscribing', body: 'This takes a second.' },
    done: { title: 'You are unsubscribed', body: 'You will not receive further emails from this sender. You can close this page.' },
    invalid: { title: 'This link is not valid', body: 'The unsubscribe link is incomplete or has been changed. Use the link from the email again, or reply to the email and ask to be removed.' },
    error: { title: 'Something went wrong', body: 'We could not reach the server. Try again in a minute, or reply to the email and ask to be removed.' },
  };

  return (
    <main className="min-h-screen bg-gray-50 flex items-start justify-center px-4">
      <div className="mt-[12vh] w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 text-center">
        {brand.logo_url && /^https:\/\//.test(brand.logo_url)
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={brand.logo_url} alt={name} className="mx-auto max-h-9 max-w-[180px]" />
          : name ? <div className="text-lg font-semibold text-gray-900">{name}</div> : null}
        <h1 className="mt-5 text-xl font-semibold text-gray-900" aria-live="polite">{copy[state].title}</h1>
        <p className="mt-2 text-gray-600">{copy[state].body}</p>
        {(state === 'ready' || state === 'working' || state === 'error') && (
          <button type="button" onClick={unsubscribe} disabled={state === 'working'} style={{ backgroundColor: accent }}
            className="mt-5 rounded-lg px-6 py-2.5 text-white disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-500">
            {state === 'working' ? 'Unsubscribing…' : state === 'error' ? 'Try again' : 'Unsubscribe'}
          </button>
        )}
        {brand.support_email && <p className="mt-6 text-sm text-gray-500">Questions? Write to <a className="underline" href={`mailto:${brand.support_email}`}>{brand.support_email}</a>.</p>}
      </div>
    </main>
  );
}

export default function UnsubscribePage() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}
