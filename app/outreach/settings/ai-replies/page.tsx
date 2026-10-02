import { redirect } from 'next/navigation';

// Settings → AI Auto Replies moved to the AI hub (docs/outreach/AI-HUB.md §2). Old links keep working for one release:
//   no tab / tab=defaults → AI → Setup → General           tab=consent / tab=reports → AI → Setup → Replies, same tab
//   tab=activity          → AI → Activity, Replies only (the run log and its drawer are gone)
export default async function AiRepliesMovedPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  const t = Array.isArray(tab) ? tab[0] : tab;
  if (t === 'consent' || t === 'reports') redirect(`/outreach/ai/setup/replies?tab=${t}`);
  if (t === 'activity') redirect('/outreach/ai/activity?feature=reply');
  redirect('/outreach/ai/setup/general');
}
