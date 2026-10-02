import { redirect } from 'next/navigation';

// Websites moved out of Settings to its own sidebar item (AI Website Chatbots). Old links keep working, ?tab= included.
export default async function WebsiteMovedPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const { id } = await params;
  const { tab } = await searchParams;
  const t = Array.isArray(tab) ? tab[0] : tab;
  redirect(`/outreach/websites/${encodeURIComponent(id)}${t ? `?tab=${encodeURIComponent(t)}` : ''}`);
}
