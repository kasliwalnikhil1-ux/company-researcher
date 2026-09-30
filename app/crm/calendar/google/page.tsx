'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { parseError } from '@/lib/crm/api';
import { calendarApi } from '@/lib/crm/calendar';
import { ErrorBox, Spinner } from '@/components/crm/ui';

// Google returns here after "Connect Google Calendar" when the app runs on localhost (Desk's desktop OAuth client only
// accepts loopback addresses). The address carries ?state=…&code=…; crm-mcp finishes the sign-in and stores it.
export default function GoogleCalendarReturn() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const address = window.location.href;
    calendarApi.finish(address)
      .then((r) => {
        const q = new URLSearchParams({ calendar: 'connected', account: r.email });
        if (r.warning) q.set('warning', r.warning);
        if (r.note) q.set('note', r.note);
        router.replace(`/crm/calendar?${q}`);
      })
      .catch((e) => setError(parseError(e).message));
  }, [router]);

  return (
    <div className="max-w-lg mx-auto py-16 space-y-3 text-center">
      {error ? (
        <>
          <ErrorBox message={`Could not connect Google Calendar: ${error}`} />
          <Link href="/crm/calendar" className="text-sm text-indigo-700 hover:underline">Back to Calendar</Link>
        </>
      ) : (
        <div className="flex items-center justify-center gap-2 text-sm text-gray-600"><Spinner /> Connecting your Google Calendar…</div>
      )}
    </div>
  );
}
