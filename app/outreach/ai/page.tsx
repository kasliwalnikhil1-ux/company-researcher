import { redirect } from 'next/navigation';

// AI hub: the first page is the queue of things that wait for a person.
export default function AiHubIndexPage() {
  redirect('/outreach/ai/needs-you');
}
