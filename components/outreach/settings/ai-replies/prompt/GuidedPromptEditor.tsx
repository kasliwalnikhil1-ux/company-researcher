'use client';

import type { ReactNode } from 'react';
import type { PromptSettings, StageDef } from '@/lib/outreach/aiReplies';
import type { DraftPromptV2, PromptSectionsV2 } from '@/lib/outreach/aiRepliesSequence';
import { Textarea } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { EMPTY_SECTIONS, SECTION_META } from './promptModel';
import PromptSettingsForm from './PromptSettingsForm';
import SafetyRules from './SafetyRules';
import StageTable from './StageTable';

/**
 * The guided sections (Who I am · How a conversation goes + stage table · Hand to a person when · Stop when · Facts · Style),
 * the prompt-level settings and the safety rules. Raw prompts stay a single text box: there is no guided/raw switch.
 * The Situations text is shown only while it can still be converted to cards (`situationsSlot` renders the button).
 */
export default function GuidedPromptEditor({ value, onChange, readOnly, lockedKeys, showSituations, situationsSlot, afterFlow }: {
  value: DraftPromptV2;
  onChange: (next: DraftPromptV2) => void;
  readOnly: boolean;
  lockedKeys: Set<string>;
  /** Show the pre-cards "Situations" free text. */
  showSituations?: boolean;
  /** Rendered under the Situations text (the "Convert to cards" button). */
  situationsSlot?: ReactNode;
  /** Rendered right after the stage table (the sequence card puts the Scenario cards here). */
  afterFlow?: ReactNode;
}) {
  const sections: PromptSectionsV2 = { ...EMPTY_SECTIONS, ...(value.sections ?? {}) };
  const setSection = (key: keyof PromptSectionsV2, text: string) => onChange({ ...value, sections: { ...sections, [key]: text } });
  const setSettings = (patch: Partial<PromptSettings>) => onChange({ ...value, settings: { ...value.settings, ...patch } });

  if (value.editor_mode === 'raw') {
    return (
      <div className="space-y-4">
        <Textarea label="Prompt" rows={22} readOnly={readOnly} value={value.body} className="font-mono text-xs leading-relaxed" onChange={(e) => onChange({ ...value, body: e.target.value })} />
        <Note>This prompt is written as one text. Stage rules are not checked automatically; the safety rules still apply. Keep a &ldquo;## Stop when&rdquo; heading so the AI knows when to hand over.</Note>
        <section className="space-y-3">
          <h4 className="text-sm font-semibold text-gray-900">Settings</h4>
          <PromptSettingsForm value={value.settings} disabled={readOnly} onChange={setSettings} />
        </section>
        <SafetyRules />
      </div>
    );
  }

  const stopEmpty = !sections.stop.trim();

  return (
    <div className="space-y-5">
      {SECTION_META.map((m) => {
        if (m.legacy && !showSituations) return null;
        return (
          <div key={m.key} className="space-y-2">
            <Textarea label={m.title} hint={m.hint} rows={m.rows} readOnly={readOnly} value={sections[m.key] ?? ''} onChange={(e) => setSection(m.key, e.target.value)} />
            {m.key === 'stop' && stopEmpty && <Note tone="amber">No Stop section. The AI will only stop after the reply limit set on this sequence.</Note>}
            {m.legacy && situationsSlot}
            {m.key === 'flow' && (
              <section aria-labelledby="ai-stage-table" className="space-y-2 pt-1">
                <div>
                  <h4 id="ai-stage-table" className="text-sm font-semibold text-gray-900">Conversation stages</h4>
                  <p className="text-xs text-gray-500">The AI moves through these in order. Early stages never pitch; the pitch stage waits for the number of replies set on this sequence unless they ask.</p>
                </div>
                <StageTable stages={value.settings.stages} lockedKeys={lockedKeys} disabled={readOnly} onChange={(stages: StageDef[]) => setSettings({ stages })} />
                {afterFlow}
              </section>
            )}
          </div>
        );
      })}
      <section aria-labelledby="ai-prompt-settings" className="space-y-3">
        <h4 id="ai-prompt-settings" className="text-sm font-semibold text-gray-900">Settings</h4>
        <PromptSettingsForm value={value.settings} disabled={readOnly} onChange={setSettings} />
      </section>
      <SafetyRules />
    </div>
  );
}
