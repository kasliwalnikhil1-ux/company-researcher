'use client';

import ClientRedirect from '@/components/outreach/ClientRedirect';

const to = (sp: URLSearchParams) => {
  const t = sp.get('tab');
  if (t === 'consent' || t === 'reports') return `/outreach/ai/setup/replies?tab=${t}`;
  if (t === 'activity') return '/outreach/ai/activity?feature=reply';
  return '/outreach/ai/setup/general';
};

// Settings → AI Auto Replies moved to the AI hub (docs/outreach/AI-HUB.md §2). Old links keep working for one release:
//   no tab / tab=defaults → AI → Setup → General           tab=consent / tab=reports → AI → Setup → Replies, same tab
//   tab=activity          → AI → Activity, Replies only (the run log and its drawer are gone)
export default function AiRepliesMovedPage() {
  return <ClientRedirect to={to} />;
}
