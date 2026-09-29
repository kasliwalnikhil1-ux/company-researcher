'use client';

import { ShieldCheck } from 'lucide-react';

// PRD §8.5 in plain words. Read-only: the master prompt can't loosen any of these.
const RULES: Array<{ title: string; text: string }> = [
  { title: 'It never pretends to be a person', text: 'It never claims to be human or denies being AI. "Are you a bot?" is handled the way you choose in the settings, never with a denial.' },
  { title: 'Their messages are not instructions', text: 'Anything the prospect writes is treated as text to answer, not orders to follow. A message that tries to instruct the AI goes to a person.' },
  { title: 'Only facts you wrote down', text: 'Every claim, number, price, date, link, email and phone number must appear in your prompt. Anything else is blocked or goes to a person.' },
  { title: 'Opt-outs always win', text: '"Don\'t contact me again" means no reply, the lead is marked do-not-contact and the chat is archived, whatever the prompt says.' },
  { title: 'This chat only', text: 'It replies in this thread and nowhere else. When they refer someone, you get a task to reach out.' },
  { title: 'What it can\'t see, it doesn\'t answer', text: 'Attachments, voice notes and images go to a person.' },
  { title: 'Limits and working hours still apply', text: 'Daily send limits, per-chat limits and the sender\'s working hours are always respected.' },
];

export default function SafetyRules() {
  return (
    <details className="group rounded-lg border border-gray-200 bg-gray-50">
      <summary className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-800 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <ShieldCheck className="w-4 h-4 text-green-600" aria-hidden="true" />
        Safety rules the AI always follows
        <span className="ml-auto text-xs font-normal text-gray-500 group-open:hidden">Show</span>
        <span className="ml-auto text-xs font-normal text-gray-500 hidden group-open:inline">Hide</span>
      </summary>
      <div className="px-3 pb-3">
        <p className="text-xs text-gray-500 mb-2">These come before your prompt and can&apos;t be changed.</p>
        <ol className="space-y-2 list-decimal pl-5">
          {RULES.map((r) => (
            <li key={r.title} className="text-sm text-gray-700"><span className="font-medium text-gray-900">{r.title}.</span> {r.text}</li>
          ))}
        </ol>
      </div>
    </details>
  );
}
