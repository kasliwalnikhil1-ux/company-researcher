import { redirect } from 'next/navigation';

// Settings → AI Personalization moved to the AI hub: the provider, key and finder keys are in AI → Setup → General, the
// variables in AI → Setup → Personalized lines. Old links keep working for one release.
export default function AiSettingsMovedPage() {
  redirect('/outreach/ai/setup/general');
}
