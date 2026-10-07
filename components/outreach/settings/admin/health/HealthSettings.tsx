'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rpc } from '@/lib/outreach/api';
import { Button, Card, Input, Select, Table, Td, Th, Toggle, useToast } from '@/components/outreach/ui';
import { fmtValue, type HealthCheck, type HealthSettings as Settings } from '@/lib/outreach/health';

const TIME_ZONES = ['Asia/Kolkata', 'UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Singapore', 'Australia/Sydney'];

function ThresholdRow({ c, onSaved }: { c: HealthCheck; onSaved: () => void }) {
  const [w, setW] = useState(c.watch_at == null ? '' : String(c.watch_at));
  const [a, setA] = useState(c.act_at == null ? '' : String(c.act_at));
  const { show, node } = useToast();
  const m = useMutation({
    mutationFn: () => rpc('health_set_threshold', { p_key: c.key, p_watch_at: w.trim() === '' ? null : Number(w), p_act_at: a.trim() === '' ? null : Number(a) }),
    onSuccess: () => { onSaved(); show(`Saved ${c.name}.`); }, onError: (e: Error) => show(e.message, 'error'),
  });
  const dirty = (w.trim() === '' ? null : Number(w)) !== c.watch_at || (a.trim() === '' ? null : Number(a)) !== c.act_at;
  return (
    <tr>
      <Td className="text-gray-900">{c.name}<div className="text-[11px] text-gray-400 font-mono">{c.key}{c.immediate ? ' · immediate' : c.urgent ? ' · urgent' : ''}</div></Td>
      <Td className="text-gray-500 text-xs">{c.unit ?? '—'}</Td>
      <Td><input value={w} onChange={(e) => setW(e.target.value)} inputMode="decimal" className="w-24 px-2 py-1 text-sm border border-gray-200 rounded tabular-nums" placeholder="none" aria-label={`Watch line for ${c.name}`} /></Td>
      <Td><input value={a} onChange={(e) => setA(e.target.value)} inputMode="decimal" className="w-24 px-2 py-1 text-sm border border-gray-200 rounded tabular-nums" placeholder="none" aria-label={`Act line for ${c.name}`} /></Td>
      <Td className="text-gray-500 text-xs tabular-nums">{fmtValue(c.value, c.unit)}</Td>
      <Td>{dirty && <Button size="sm" onClick={() => m.mutate()} loading={m.isPending}>Save</Button>}{node}</Td>
    </tr>
  );
}

/** Mounted with `key={settings.updated_at}` by the page, so a save elsewhere resets the form. */
export default function HealthSettings({ settings, checks }: { settings: Settings; checks: HealthCheck[] }) {
  const qc = useQueryClient();
  const [s, setS] = useState<Settings>(settings);
  const [emails, setEmails] = useState(settings.email_to.join(', '));
  const { show, node } = useToast();
  const save = useMutation({
    mutationFn: () => rpc('health_settings_set', { p: { supabase_plan: s.supabase_plan, compute_size: s.compute_size, email_to: emails.split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean), email_hour: Number(s.email_hour), time_zone: s.time_zone, urgent_email: s.urgent_email, ai_monthly_budget_usd: s.ai_monthly_budget_usd === null || (s.ai_monthly_budget_usd as unknown) === '' ? null : Number(s.ai_monthly_budget_usd), ai_price_in_per_m: Number(s.ai_price_in_per_m), ai_price_out_per_m: Number(s.ai_price_out_per_m), has_paying_customers: s.has_paying_customers } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['health-overview'] }); qc.invalidateQueries({ queryKey: ['health-usage'] }); show('Saved.'); },
    onError: (e: Error) => show(e.message, 'error'),
  });
  const onSaved = () => qc.invalidateQueries({ queryKey: ['health-overview'] });
  const sorted = [...checks].sort((a, b) => a.key.localeCompare(b.key));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Emails">
          <div className="space-y-3">
            <Input label="Send the daily email to" hint="Comma-separated. The verdict is in the subject line; it arrives every day, including when everything is fine, so a missing email is itself a signal." value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="you@company.com" />
            <div className="grid grid-cols-2 gap-3">
              <Select label="At" value={String(s.email_hour)} onChange={(e) => setS({ ...s, email_hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</Select>
              <Select label="Time zone" value={s.time_zone} onChange={(e) => setS({ ...s, time_zone: e.target.value })}>{[...new Set([s.time_zone, ...TIME_ZONES])].map((z) => <option key={z} value={z}>{z}</option>)}</Select>
            </div>
            <Toggle checked={s.urgent_email} onChange={(v) => setS({ ...s, urgent_email: v })} label="Urgent email when a check turns red (once, again after 4 hours, once when it recovers)" />
            <div className="text-xs text-gray-500">Last daily email: {s.last_daily_email_on ?? 'never'}.</div>
          </div>
        </Card>
        <Card title="Supabase plan and AI budget">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Select label="Supabase plan" value={s.supabase_plan} onChange={(e) => setS({ ...s, supabase_plan: e.target.value as 'free' | 'pro' })}><option value="free">Free</option><option value="pro">Pro</option></Select>
              <Select label="Compute size" value={s.compute_size} onChange={(e) => setS({ ...s, compute_size: e.target.value })}>{['nano', 'micro', 'small', 'medium', 'large', 'xl', '2xl'].map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</Select>
            </div>
            <Toggle checked={s.has_paying_customers} onChange={(v) => setS({ ...s, has_paying_customers: v })} label="There are paying customers (the Free → Pro rule)" />
            <Input label="Monthly AI budget (USD, platform key)" hint="AI spend turns amber at 80% and red at 100%. Leave empty to skip the check." value={s.ai_monthly_budget_usd ?? ''} onChange={(e) => setS({ ...s, ai_monthly_budget_usd: e.target.value === '' ? null : (e.target.value as unknown as number) })} inputMode="decimal" />
            <div className="grid grid-cols-2 gap-3">
              <Input label="$ per million input tokens" value={s.ai_price_in_per_m} onChange={(e) => setS({ ...s, ai_price_in_per_m: e.target.value as unknown as number })} inputMode="decimal" />
              <Input label="$ per million output tokens" value={s.ai_price_out_per_m} onChange={(e) => setS({ ...s, ai_price_out_per_m: e.target.value as unknown as number })} inputMode="decimal" />
            </div>
          </div>
        </Card>
      </div>
      <div><Button onClick={() => save.mutate()} loading={save.isPending}>Save settings</Button></div>
      <Card title="Thresholds">
        <p className="text-xs text-gray-500 mb-3">Watch and act lines are rows, editable here without a deploy. Where Supabase documents a threshold it is used; where the platform spec set one, it is kept. Every change is written to the audit log.</p>
        <div className="overflow-x-auto">
          <Table>
            <thead><tr><Th>Check</Th><Th>Unit</Th><Th>Watch at</Th><Th>Act at</Th><Th>Now</Th><Th></Th></tr></thead>
            <tbody>{sorted.map((c) => <ThresholdRow key={c.key} c={c} onSaved={onSaved} />)}</tbody>
          </Table>
        </div>
      </Card>
      <Card title="Secrets and what runs where">
        <ul className="text-sm text-gray-700 space-y-1 list-disc pl-5">
          <li><code>ops.health_run()</code> runs inside the database every 5 minutes (no Edge Function), then <code>outreach-health-collect</code> every 5 minutes and <code>outreach-health-daily</code> hourly.</li>
          <li>The metrics endpoint uses the runtime&apos;s service key. The logs API and the advisors need <code>OUTREACH_MGMT_TOKEN</code>, a Management API token with <code>analytics_logs_read</code> and <code>advisors_read</code>; without it those three checks stay grey.</li>
          <li>An outside uptime monitor can watch <code>/functions/v1/outreach-health-ping</code>: it answers <code>ok</code> or <code>stale</code> and nothing else.</li>
        </ul>
      </Card>
      {node}
    </div>
  );
}
