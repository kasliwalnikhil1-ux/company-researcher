'use client';

import ClientRedirect from '@/components/outreach/ClientRedirect';

const to = () => '/outreach/websites';

// Websites moved out of Settings to its own sidebar item (AI Website Chatbots). Old links keep working.
export default function WebsitesMovedPage() {
  return <ClientRedirect to={to} />;
}
