'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Briefcase, GraduationCap, Languages, Newspaper, RefreshCw, Sparkles, ThumbsUp, Users } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useSenders } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import { ik, requestEnrichment, useLeadProfile, type EnrichStatus, type LeadWithIntel, type ProfileExperience } from '@/lib/outreach/intel';
import { Badge, Button, Card, ErrorBox, Spinner, fmtDate } from '@/components/outreach/ui';
import type { ToastFn } from '../helpers';

const STATUS: Record<EnrichStatus, { tone: 'gray' | 'blue' | 'green' | 'red'; label: string; help: string }> = {
  none: { tone: 'gray', label: 'Not enriched', help: 'The full profile has not been read yet. Leads in a sequence are enriched for free on the profile fetch the sequence already does.' },
  waiting: { tone: 'blue', label: 'Waiting', help: 'Queued. Background enrichment only uses profile views that are left over after the day’s sequence actions.' },
  done: { tone: 'green', label: 'Enriched', help: '' },
  failed: { tone: 'red', label: 'Failed', help: 'The profile could not be read after three tries. Sequences do not wait for it. You can ask again.' },
};
const SOURCE_LABEL: Record<string, string> = { prefetch: 'before a sequence step', step: 'a sequence step', background: 'background enrichment', manual: 'a manual request', draft: 'an AI draft' };
const SECTION_LABEL: Record<string, string> = { about: 'About', experience: 'Experience', education: 'Education', skills: 'Skills', languages: 'Languages' };

function timeInRole(startedOn: string | null): string | null {
  if (!startedOn) return null;
  const d = new Date(startedOn);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const months = Math.max(0, (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth());
  const y = Math.floor(months / 12); const m = months % 12;
  const span = y > 0 ? `${y} yr${y === 1 ? '' : 's'}${m ? ` ${m} mo` : ''}` : `${m} mo`;
  return `since ${d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })} (${span})`;
}

function span(x: ProfileExperience): string {
  const s = [x.start, x.current ? 'now' : x.end].filter(Boolean).join(' to ');
  return s;
}

function Block({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">{icon}{title}</div>
      {children}
    </div>
  );
}

export function EnrichmentCard({ lead, toast }: { lead: LeadWithIntel; toast: ToastFn }) {
  const { workspace, canWrite } = useWorkspace();
  const qc = useQueryClient();
  const status: EnrichStatus = (lead.enrich_status as EnrichStatus | null | undefined) ?? 'none';
  const profileQ = useLeadProfile(lead.id, status === 'waiting');
  const senders = useSenders(workspace?.id);
  const [busy, setBusy] = useState(false);
  const [wantPosts, setWantPosts] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showAllAbout, setShowAllAbout] = useState(false);

  const p = profileQ.data ?? null;
  const enrichedBy = p?.enriched_by_sender ? senders.data?.find((s) => s.id === p.enriched_by_sender) : undefined;
  const hasLinkedIn = !!(lead.public_identifier || lead.provider_id);
  const past = (p?.experience ?? []).filter((x) => !x.current);
  const posts = p?.posts ?? [];
  const empty = p?.empty_sections ?? [];
  const meta = STATUS[status] ?? STATUS.none;

  const reEnrich = async () => {
    if (!workspace) return;
    setBusy(true); setNote(null);
    try {
      const r = await requestEnrichment(workspace.id, [lead.id], { wantPosts, force: true, reason: 're_enrich' });
      if (r.queued > 0) toast('Enrichment requested');
      else toast(r.skipped_no_linkedin_id ? 'This lead has no LinkedIn id, so there is no profile to read.' : 'Nothing was queued. The lead may be marked do-not-contact.', 'error');
      setNote(r.note ?? null);
      qc.invalidateQueries({ queryKey: qk.lead(lead.id) });
      qc.invalidateQueries({ queryKey: ik.profile(lead.id) });
    } catch (e) { toast(parseError(e).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-gray-400" /> Enrichment</span>}
      actions={canWrite ? <Button size="sm" variant="secondary" loading={busy} disabled={!hasLinkedIn} onClick={reEnrich} title={hasLinkedIn ? 'Read the full profile again, even if it is fresh' : 'This lead has no LinkedIn id'}><RefreshCw className="w-3.5 h-3.5" /> {p?.enriched_at ? 'Re-enrich' : 'Enrich'}</Button> : undefined}>
      <div className="space-y-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            {p?.enriched_at && <span className="text-gray-600">{fmtDate(p.enriched_at)}{enrichedBy ? ` by ${enrichedBy.display_name ?? 'a sender'}` : ''}{p.source ? `, from ${SOURCE_LABEL[p.source] ?? p.source}` : ''}</span>}
          </div>
          {meta.help && <p className="text-xs text-gray-500 mt-1">{meta.help}</p>}
          {empty.length > 0 && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-2">Some sections came back empty and will be retried: {empty.map((s) => SECTION_LABEL[s] ?? s).join(', ')}. An empty answer never replaces what is already stored.</p>}
          {canWrite && hasLinkedIn && (
            <label className="flex items-center gap-2 text-xs text-gray-600 mt-2">
              <input type="checkbox" checked={wantPosts} onChange={(e) => setWantPosts(e.target.checked)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
              Also fetch recent posts on the next run
            </label>
          )}
          {note && <p className="text-xs text-gray-500 mt-2">{note}</p>}
        </div>

        {profileQ.isLoading && <Spinner className="py-4" />}
        {profileQ.error && <ErrorBox message={parseError(profileQ.error).message} />}
        {profileQ.isSuccess && !p && status !== 'waiting' && <p className="text-sm text-gray-400">No profile data stored yet.</p>}

        {p && (
          <>
            {(p.follower_count != null || p.connections_count != null || p.profile_language) && (
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-700">
                {p.follower_count != null && <span className="inline-flex items-center gap-1"><Users className="w-3.5 h-3.5 text-gray-400" /><span className="font-medium tabular-nums">{p.follower_count.toLocaleString()}</span> followers</span>}
                {p.connections_count != null && <span><span className="font-medium tabular-nums">{p.connections_count.toLocaleString()}</span> connections</span>}
                {p.profile_language && <span className="text-gray-500">Profile language: {p.profile_language}</span>}
              </div>
            )}

            {p.about && (
              <Block icon={null} title="About">
                <p className={`text-sm text-gray-700 whitespace-pre-wrap ${showAllAbout ? '' : 'line-clamp-5'}`}>{p.about}</p>
                {p.about.length > 320 && <button type="button" onClick={() => setShowAllAbout((v) => !v)} className="text-xs text-indigo-600 hover:underline mt-0.5">{showAllAbout ? 'Show less' : 'Show all'}</button>}
              </Block>
            )}

            {(p.current_title || p.current_company) && (
              <Block icon={<Briefcase className="w-3 h-3" />} title="Current role">
                <p className="text-sm text-gray-900">{[p.current_title, p.current_company].filter(Boolean).join(' at ')}</p>
                {timeInRole(p.current_started_on) && <p className="text-xs text-gray-500">{timeInRole(p.current_started_on)}</p>}
              </Block>
            )}

            {past.length > 0 && (
              <Block icon={<Briefcase className="w-3 h-3" />} title="Past roles">
                <ul className="space-y-1">
                  {past.slice(0, 6).map((x, i) => (
                    <li key={i} className="text-sm text-gray-700"><span className="text-gray-900">{[x.title, x.company].filter(Boolean).join(' at ') || 'Role'}</span>{span(x) && <span className="text-xs text-gray-500"> · {span(x)}</span>}</li>
                  ))}
                </ul>
                {past.length > 6 && <p className="text-xs text-gray-400 mt-1">and {past.length - 6} more</p>}
              </Block>
            )}

            {!!p.education?.length && (
              <Block icon={<GraduationCap className="w-3 h-3" />} title="Education">
                <ul className="space-y-1">
                  {p.education.slice(0, 4).map((x, i) => (
                    <li key={i} className="text-sm text-gray-700"><span className="text-gray-900">{x.school ?? 'School'}</span>{[x.degree, x.field].filter(Boolean).length > 0 && <span className="text-gray-600"> · {[x.degree, x.field].filter(Boolean).join(', ')}</span>}{[x.start, x.end].filter(Boolean).length > 0 && <span className="text-xs text-gray-500"> · {[x.start, x.end].filter(Boolean).join(' to ')}</span>}</li>
                  ))}
                </ul>
              </Block>
            )}

            {!!p.skills?.length && (
              <Block icon={null} title="Skills">
                <div className="flex flex-wrap gap-1">
                  {p.skills.slice(0, 15).map((s) => <span key={s} className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">{s}</span>)}
                  {p.skills.length > 15 && <span className="text-xs text-gray-400 self-center">+{p.skills.length - 15}</span>}
                </div>
              </Block>
            )}

            {!!p.languages?.length && (
              <Block icon={<Languages className="w-3 h-3" />} title="Languages"><p className="text-sm text-gray-700">{p.languages.join(', ')}</p></Block>
            )}

            <Block icon={<Newspaper className="w-3 h-3" />} title="Recent posts">
              {posts.length === 0 ? (
                <p className="text-xs text-gray-500">{p.posts_fetched_at ? `No posts found when checked ${fmtDate(p.posts_fetched_at)}.` : 'Posts are only fetched when something uses them: a recent-post variable, an AI line, an AI routing step or a “posted recently” filter.'}</p>
              ) : (
                <ul className="space-y-2">
                  {posts.slice(0, 5).map((post, i) => (
                    <li key={post.id ?? i} className="text-sm border border-gray-100 rounded-lg p-2.5 bg-gray-50/60">
                      <p className="text-gray-700 whitespace-pre-wrap line-clamp-4">{post.text || <span className="text-gray-400">Post without text</span>}</p>
                      <div className="flex flex-wrap items-center gap-x-3 text-xs text-gray-500 mt-1">
                        {post.date && <span>{fmtDate(post.date, false)}</span>}
                        {post.reactions != null && <span className="inline-flex items-center gap-1"><ThumbsUp className="w-3 h-3" />{Number(post.reactions).toLocaleString()} reactions</span>}
                        {post.comments != null && <span>{Number(post.comments).toLocaleString()} comments</span>}
                        {post.url && /^https:\/\//i.test(post.url) && <a href={post.url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">Open post</a>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Block>
          </>
        )}
      </div>
    </Card>
  );
}
