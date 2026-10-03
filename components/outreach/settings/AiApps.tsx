'use client';

import { useId, useState } from 'react';
import { Plus } from 'lucide-react';
import { Drawer } from '@/components/outreach/sequences/Modals';
import { CopyField, Note } from '@/components/outreach/settings/shared';
import { cn } from '@/lib/utils';

// The GrowthxAI Outreach MCP server (supabase/functions/outreach-mcp). ChatGPT signs in only through its own alias URL;
// every other app uses /mcp. Both act as the signed-in person, with their role and client scope.
const MCP_BASE = `${(process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '')}/functions/v1/outreach-mcp`;
const NAME = 'GrowthxAI Outreach';
const SLUG = 'growthxai-outreach';

type AppKey = 'chatgpt' | 'claude' | 'gemini' | 'grok';

/* Official marks (lobehub/icons), 24×24. */
function OpenAiMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className={className} aria-hidden>
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
    </svg>
  );
}

function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
    </svg>
  );
}

function GeminiMark({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  const d = 'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z';
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d={d} fill="#3186FF" />
      <path d={d} fill={`url(#${id}a)`} />
      <path d={d} fill={`url(#${id}b)`} />
      <path d={d} fill={`url(#${id}c)`} />
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id={`${id}a`} x1="7" x2="11" y1="15.5" y2="12"><stop stopColor="#08B962" /><stop offset="1" stopColor="#08B962" stopOpacity="0" /></linearGradient>
        <linearGradient gradientUnits="userSpaceOnUse" id={`${id}b`} x1="8" x2="11.5" y1="5.5" y2="11"><stop stopColor="#F94543" /><stop offset="1" stopColor="#F94543" stopOpacity="0" /></linearGradient>
        <linearGradient gradientUnits="userSpaceOnUse" id={`${id}c`} x1="3.5" x2="17.5" y1="13.5" y2="12"><stop stopColor="#FABC12" /><stop offset=".46" stopColor="#FABC12" stopOpacity="0" /></linearGradient>
      </defs>
    </svg>
  );
}

function GrokMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className={className} aria-hidden>
      <path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
    </svg>
  );
}

/** The app's mark in its square tile, as the app shows it in its own store listings. */
export function AiAppIcon({ app, size = 'md' }: { app: AppKey; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'w-11 h-11 rounded-xl' : 'w-10 h-10 rounded-lg';
  const mark = size === 'lg' ? 'w-6 h-6' : 'w-5 h-5';
  if (app === 'claude') return <span className={cn(box, 'flex items-center justify-center flex-shrink-0 bg-[#D97757] text-white')}><ClaudeMark className={mark} /></span>;
  if (app === 'grok') return <span className={cn(box, 'flex items-center justify-center flex-shrink-0 bg-black text-white')}><GrokMark className={mark} /></span>;
  return (
    <span className={cn(box, 'flex items-center justify-center flex-shrink-0 bg-white border border-gray-200 text-gray-900')}>
      {app === 'chatgpt' ? <OpenAiMark className={mark} /> : <GeminiMark className={mark} />}
    </span>
  );
}

type Step = React.ReactNode;
const b = (t: string) => <strong className="font-semibold text-gray-900">{t}</strong>;
const code = (t: string) => <code className="px-1 py-0.5 rounded bg-gray-100 text-[12px] font-mono text-gray-800">{t}</code>;

const APPS: Array<{ key: AppKey; label: string; url: string; blurb: string; urlLabel: string; requirement?: string; steps: Step[]; command?: { label: string; value: string; hint?: string }; warning?: React.ReactNode }> = [
  {
    key: 'chatgpt', label: 'ChatGPT', url: `${MCP_BASE}/mcp-chatgpt`, urlLabel: 'Plugin URL',
    blurb: 'Use GrowthxAI Outreach from ChatGPT for outreach work.',
    requirement: 'Needs Developer mode, which is on paid ChatGPT plans. On a Business or Enterprise workspace an admin may have to allow it first.',
    steps: [
      <>In ChatGPT, open {b('Settings → Security and login')} and turn on {b('Developer mode')}.</>,
      <>Go to <a href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline font-medium">chatgpt.com/plugins</a> and click the {b('+')} button.</>,
      <>Name it {b(NAME)} and paste the plugin URL below under {b('Connection')}.</>,
      <>Choose {b('OAuth')} as the authentication and create the plugin.</>,
      <>Sign in with your GrowthxAI account and approve access.</>,
      <>Start a new chat, add {b(NAME)} from the tools menu and ask {b('“What’s in my outreach workspace?”')}</>,
    ],
    warning: <>Use the URL ending in {code('/mcp-chatgpt')} for ChatGPT. The one ending in {code('/mcp')} does not sign in from ChatGPT.</>,
  },
  {
    key: 'claude', label: 'Claude', url: `${MCP_BASE}/mcp`, urlLabel: 'Connector URL',
    blurb: 'Use GrowthxAI Outreach from Claude for outreach work.',
    steps: [
      <>In Claude, open {b('Settings → Connectors')} and choose {b('Add custom connector')}.</>,
      <>Name it {b(NAME)} and paste the connector URL below.</>,
      <>Click {b('Connect')}, sign in with your GrowthxAI account and click {b('Authorize access')}.</>,
      <>Start a new chat and ask {b('“What’s in my outreach workspace?”')}</>,
    ],
    command: { label: 'Using Claude Code? Run this instead', value: `claude mcp add --transport http ${SLUG} ${MCP_BASE}/mcp`, hint: 'Then type /mcp in Claude Code and sign in.' },
  },
  {
    key: 'gemini', label: 'Gemini CLI', url: `${MCP_BASE}/mcp`, urlLabel: 'Server URL',
    blurb: 'Use GrowthxAI Outreach from Gemini CLI for outreach work.',
    steps: [
      <>In your terminal, run the command below. It adds {b(NAME)} to your Gemini CLI settings.</>,
      <>Start {code('gemini')} and type {code(`/mcp auth ${SLUG}`)}. A browser window opens.</>,
      <>Sign in with your GrowthxAI account and approve access, then go back to the terminal.</>,
      <>Ask {b('“What’s in my outreach workspace?”')}</>,
    ],
    command: { label: 'Command', value: `gemini mcp add --transport http ${SLUG} ${MCP_BASE}/mcp` },
  },
  {
    key: 'grok', label: 'Grok', url: `${MCP_BASE}/mcp`, urlLabel: 'Connector URL',
    blurb: 'Use GrowthxAI Outreach from Grok for outreach work.',
    requirement: 'Custom connectors are on paid Grok plans.',
    steps: [
      <>Go to <a href="https://grok.com/connectors" target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline font-medium">grok.com/connectors</a> and choose {b('New connector → Custom')}.</>,
      <>Name it {b(NAME)} and paste the connector URL below.</>,
      <>Sign in with your GrowthxAI account and approve access.</>,
      <>Start a new chat with the connector on and ask {b('“What’s in my outreach workspace?”')}</>,
    ],
  },
];

const EXAMPLES = ['Any pending replies?', 'Build a 4-touch sequence for fintech CFOs and dry-run it on my list.', 'Why isn’t anything sending?', 'Give me a client report for last month.'];

/** "AI apps" on Settings → Integrations → Connected apps: how to add the GrowthxAI Outreach MCP server to each AI app. */
export default function AiApps() {
  const [open, setOpen] = useState<AppKey | null>(null);
  const app = APPS.find((a) => a.key === open);
  return (
    <section className="mb-10" aria-labelledby="ai-apps-heading">
      <h2 id="ai-apps-heading" className="text-base font-semibold text-gray-900">AI apps</h2>
      <p className="text-sm text-gray-600 mt-1 mb-4 max-w-3xl">Work in this workspace by chatting with your AI app: triage replies, build sequences, check senders and pull reports. It acts as you, so it sees and does only what you can in the app, and asks before anything is sent.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 max-w-4xl">
        {APPS.map((a) => (
          <button key={a.key} type="button" onClick={() => setOpen(a.key)} aria-label={`Add ${a.label}`}
            className="group flex items-center gap-3 rounded-xl px-3 py-3 -mx-3 text-left hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            <AiAppIcon app={a.key} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-gray-900">{a.label}</span>
              <span className="block text-xs text-gray-500 truncate">{a.blurb}</span>
            </span>
            <Plus className="w-4 h-4 text-gray-400 group-hover:text-gray-700 flex-shrink-0" aria-hidden />
          </button>
        ))}
      </div>

      <Drawer open={!!app} onClose={() => setOpen(null)} width="max-w-lg"
        title={app ? <span className="flex items-center gap-3"><AiAppIcon app={app.key} />Add {NAME} to {app.label}</span> : ''}>
        {app && (
          <div className="space-y-5 text-sm text-gray-700">
            {app.requirement && <Note tone="amber">{app.requirement}</Note>}

            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-2">How to add it</h4>
              <ol className="space-y-2.5">
                {app.steps.map((s, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="w-5 h-5 rounded-full bg-indigo-50 text-indigo-700 text-xs font-semibold flex items-center justify-center flex-shrink-0 mt-px">{i + 1}</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
            </div>

            {app.key === 'gemini' && app.command ? <CopyField label={app.command.label} value={app.command.value} /> : <CopyField label={app.urlLabel} value={app.url} />}
            {app.warning && <Note tone="amber">{app.warning}</Note>}
            {app.key !== 'gemini' && app.command && <CopyField label={app.command.label} value={app.command.value} hint={app.command.hint} />}

            <div>
              <h4 className="text-sm font-semibold text-gray-900 mb-2">Then ask things like</h4>
              <ul className="space-y-1.5">
                {EXAMPLES.map((e) => <li key={e} className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-gray-800">“{e}”</li>)}
              </ul>
            </div>

            <Note>{app.label} works with exactly your role and client scope. Anything that sends, enrolls, imports or exports is shown to you first and only happens after you say yes. If you belong to several workspaces, {app.label} asks which one to use.</Note>
          </div>
        )}
      </Drawer>
    </section>
  );
}
