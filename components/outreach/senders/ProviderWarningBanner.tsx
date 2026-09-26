'use client';

// Instagram "automated behaviour" warning (PRD §7.5): the provider's text verbatim, our interpretation, and a
// "Resume anyway" action for managers that needs a confirmation. Quiet-period badge lives here too so the
// sender header stays small.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Clock } from 'lucide-react';
import { callFn, parseError } from '@/lib/outreach/api';
import { qk } from '@/lib/outreach/queries';
import { inQuietPeriod, untilText } from '@/lib/outreach/channels';
import { Badge, Button, Modal, fmtDate } from '@/components/outreach/ui';
import { isFuture } from './helpers';
import type { Sender } from '@/lib/outreach/types';

type Notify = (message: string, type?: 'success' | 'error') => void;

export const PROVIDER_WARNING_INTERPRETATION = 'Instagram flagged automated behaviour. We dropped one warm-up level and paused for 48 hours. You can resume now if you accept the risk.';

export function QuietPeriodBadge({ sender }: { sender: Pick<Sender, 'outreach_allowed_from'> }) {
  if (!inQuietPeriod(sender)) return null;
  const left = untilText(sender.outreach_allowed_from);
  return (
    <Badge tone="blue" className="cursor-help">
      <span title={`The account connected recently. Outreach waits until ${fmtDate(sender.outreach_allowed_from)} (24-hour quiet period). Replies are not held back.`} className="inline-flex items-center gap-1">
        <Clock className="w-3 h-3" /> Outreach starts {left ? `in ${left}` : fmtDate(sender.outreach_allowed_from)}
      </span>
    </Badge>
  );
}

export function ProviderWarningBanner({ sender, isManager, canWrite, notify }: { sender: Sender; isManager: boolean; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const w = sender.provider_warning;
  if (!w) return null;
  const pausedUntil = w.paused_until ?? sender.paused_until;
  const stillPaused = isFuture(pausedUntil);

  async function resume() {
    setBusy(true);
    try {
      await callFn('sender-manage', { sender_id: sender.id, action: 'resume_after_warning' });
      notify('Outreach resumed. Keep an eye on this account for the next few days.');
      qc.invalidateQueries({ queryKey: qk.sender(sender.id) });
      qc.invalidateQueries({ queryKey: qk.senders(sender.workspace_id) });
      qc.invalidateQueries({ queryKey: qk.senderEvents(sender.id) });
      qc.invalidateQueries({ queryKey: qk.dashboard(sender.workspace_id) });
      setConfirm(false);
    } catch (e) { notify(parseError(e).message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-amber-900">Instagram sent a warning{w.at ? ` on ${fmtDate(w.at)}` : ''}</div>
          <blockquote className="mt-1.5 text-sm text-gray-800 border-l-2 border-amber-300 pl-3 whitespace-pre-wrap">{w.text}</blockquote>
          <p className="mt-2 text-sm text-amber-900">{PROVIDER_WARNING_INTERPRETATION}</p>
          <div className="mt-1 text-xs text-amber-800">
            {typeof w.level_before === 'number' && <span>Level {w.level_before} → {sender.warmup_level}. </span>}
            {stillPaused ? <span>Paused until {fmtDate(pausedUntil)}.</span> : <span>The 48 hours have passed; outreach resumes on its own once the warning is cleared.</span>}
          </div>
        </div>
        {isManager && canWrite && <Button variant="secondary" size="sm" onClick={() => setConfirm(true)}>Resume anyway</Button>}
      </div>
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Resume outreach on this account?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirm(false)} disabled={busy}>Cancel</Button><Button variant="danger" loading={busy} onClick={resume}>Resume anyway</Button></>}>
        <p className="text-sm text-gray-700">Instagram flagged this account. Resuming before the 48-hour pause ends means the next warning may restrict the account for longer, or for good. The lower warm-up level stays; it climbs back as health stays high.</p>
        <p className="text-sm text-gray-700 mt-2">If the account belongs to a client, check with them first.</p>
      </Modal>
    </div>
  );
}

export default ProviderWarningBanner;
