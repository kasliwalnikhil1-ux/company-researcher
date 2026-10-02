import { redirect } from 'next/navigation';

// Websites moved out of Settings to its own sidebar item (AI Website Chatbots). Old links keep working.
export default function WebsitesMovedPage() {
  redirect('/outreach/websites');
}
