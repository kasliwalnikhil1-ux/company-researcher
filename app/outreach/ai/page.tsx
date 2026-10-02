'use client';

import ClientRedirect from '@/components/outreach/ClientRedirect';

const to = () => '/outreach/ai/needs-you';

// AI hub: the first page is the queue of things that wait for a person.
export default function AiHubIndexPage() {
  return <ClientRedirect to={to} />;
}
