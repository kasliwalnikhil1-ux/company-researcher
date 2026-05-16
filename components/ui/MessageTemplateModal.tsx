"use client";

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { MessageTemplate, MessageTemplateSettings, TemplateChannel, CHANNEL_LABELS, PreviewCompany } from '@/contexts/MessageTemplatesContext';
import { extractTemplateVariables, renderCompanyTemplate } from '@/lib/messageTemplates';
import { toPlainText } from '@/lib/textNormalization';
import Toast from '@/components/ui/Toast';

function getCompanyLabel(company: PreviewCompany): string {
  const summary = company.summary || {};
  const candidates = [
    summary.brand_name,
    summary.company_name,
    summary.name,
    company.domain,
    company.instagram,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return 'Untitled';
}

// Chips by primaryUse
const FUNDRAISING_CHIPS: { variable: string; sampleLabel: string }[] = [
  { variable: '${first_name}', sampleLabel: 'Alex (from contact)' },
  { variable: '${twitter_line}', sampleLabel: 'I just read your tweet about...' },
  { variable: '${line1}', sampleLabel: 'I saw ..., which is why I\'m reaching out to your company.' },
  { variable: '${line2}', sampleLabel: 'I believe ... could greatly benefit us at my company.' },
  { variable: '${additional_line}', sampleLabel: 'Your custom note here...' },
  { variable: '${cleaned_name}', sampleLabel: 'Accel or John' },
  { variable: '${followUpFullDate}', sampleLabel: 'Tuesday, Jan 15' },
  { variable: '${followUpWeekdayDate}', sampleLabel: 'Tuesday Jan 15' },
  { variable: '${followUpShortDay}', sampleLabel: 'Tue' },
  { variable: '${followUpRelativeDay}', sampleLabel: 'this Tuesday' },
  { variable: '${followUpRelativeShortDay}', sampleLabel: 'this Tue' },
  { variable: '${followUpDateOnly}', sampleLabel: 'Jan 15' },
];

const B2B_CHIPS: { variable: string; sampleLabel: string }[] = [
  { variable: '${first_name}', sampleLabel: 'Alex (from contact)' },
  { variable: '${PRODUCT1}', sampleLabel: 'jewelry' },
  { variable: '${PRODUCT2}', sampleLabel: 'accessories' },
  { variable: '${salesOpenerSentence}', sampleLabel: 'Loved your latest collection.' },
  { variable: '${first_line_to_start_email}', sampleLabel: 'Congrats on your recent launch.' },
  { variable: '${subject_line}', sampleLabel: 'Congrats on the launch!' },
  { variable: '${product_types}', sampleLabel: 'jewelry and accessories' },
  { variable: '${company_name}', sampleLabel: 'Acme Co' },
  { variable: '${company_industry}', sampleLabel: 'fashion' },
  { variable: '${followUpFullDate}', sampleLabel: 'Tuesday, Jan 15' },
  { variable: '${followUpWeekdayDate}', sampleLabel: 'Tuesday Jan 15' },
  { variable: '${followUpShortDay}', sampleLabel: 'Tue' },
  { variable: '${followUpRelativeDay}', sampleLabel: 'this Tuesday' },
  { variable: '${followUpRelativeShortDay}', sampleLabel: 'this Tue' },
  { variable: '${followUpDateOnly}', sampleLabel: 'Jan 15' },
];

// Sample contact used to demo `${first_name}` in the live preview. The real
// value comes from the selected contact in the company drawer at send time.
const PREVIEW_SAMPLE_CONTACT = { first_name: 'Alex', last_name: 'Morgan', full_name: 'Alex Morgan' };

function getVariableChips(primaryUse: 'fundraising' | 'b2b') {
  return primaryUse === 'b2b' ? B2B_CHIPS : FUNDRAISING_CHIPS;
}

// Built-in variables that are always computed at render time (follow-up dates).
// These are NOT company-dependent so they should never appear in the
// per-template `variable_defaults` editor.
const BUILTIN_NON_COMPANY_VARIABLES = new Set([
  'followUpFullDate',
  'followUpWeekdayDate',
  'followUpShortDay',
  'followUpRelativeDay',
  'followUpRelativeShortDay',
  'followUpDateOnly',
]);

// Build a short multi-line snippet from a template body for previewing it
// inside the fallback dropdown.
function previewSnippet(template: string, maxLines = 3, maxChars = 160): string {
  if (!template) return '';
  const collapsed = template
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, maxLines)
    .join(' · ');
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars).trimEnd()}…` : collapsed;
}

export interface MessageTemplateFormData {
  title: string;
  channel: TemplateChannel;
  template: string;
  category?: string;
  settings?: MessageTemplateSettings | null;
}

interface MessageTemplateModalProps {
  isOpen: boolean;
  isCreating: boolean;
  editingTemplate: MessageTemplate | null;
  defaultChannel: TemplateChannel;
  channelOptions: TemplateChannel[];
  primaryUse?: 'fundraising' | 'b2b';
  previewCompanies?: PreviewCompany[];
  previewCompaniesLoading?: boolean;
  /** All templates, used to list fallback options and to resolve preview rendering. */
  allTemplates?: MessageTemplate[];
  onClose: () => void;
  onCreate: (data: MessageTemplateFormData) => Promise<void>;
  onUpdate: (id: string, data: MessageTemplateFormData) => Promise<void>;
}

const MessageTemplateModal: React.FC<MessageTemplateModalProps> = ({
  isOpen,
  isCreating,
  editingTemplate,
  defaultChannel,
  channelOptions,
  primaryUse = 'fundraising',
  previewCompanies = [],
  previewCompaniesLoading = false,
  allTemplates = [],
  onClose,
  onCreate,
  onUpdate,
}) => {
  const [formData, setFormData] = useState<{
    title: string;
    channel: TemplateChannel;
    template: string;
    category: string;
    variableDefaults: Record<string, string>;
    fallbackTemplateId: string;
  }>({
    title: '',
    channel: 'direct',
    template: '',
    category: '',
    variableDefaults: {},
    fallbackTemplateId: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [toastMessage, setToastMessage] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const [toastType, setToastType] = useState<'success' | 'error'>('error');

  const showToast = (message: string, type: 'success' | 'error' = 'error') => {
    setToastMessage(message);
    setToastType(type);
    setToastVisible(true);
  };

  const focusAndScrollTo = (el: HTMLElement | null) => {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    }, 250);
  };

  // Variables referenced by the current template body (unique, in insertion order),
  // excluding built-in computed variables (follow-up dates) which always have a value.
  const usedVariables = useMemo(
    () =>
      extractTemplateVariables(formData.template).filter(
        (v) => !BUILTIN_NON_COMPANY_VARIABLES.has(v)
      ),
    [formData.template]
  );

  // Build a stand-in template object that combines unsaved form state with the
  // saved row, so the live preview reflects edits to defaults and fallback.
  const previewTemplate = useMemo(
    () => ({
      id: editingTemplate?.id ?? '__draft__',
      template: formData.template.trim(),
      settings: {
        variable_defaults: formData.variableDefaults,
        fallback_template_id: formData.fallbackTemplateId || null,
      } as MessageTemplateSettings,
    }),
    [editingTemplate?.id, formData.template, formData.variableDefaults, formData.fallbackTemplateId]
  );

  // Patch the in-edit template into the template list so the renderer sees the
  // latest body/settings rather than the stale stored copy.
  const previewTemplateList = useMemo(() => {
    const others = allTemplates.filter((t) => t.id !== previewTemplate.id);
    return [...others, previewTemplate];
  }, [allTemplates, previewTemplate]);

  const renderedPreviews = useMemo(() => {
    const tmpl = formData.template.trim();
    if (!tmpl) return [];
    return previewCompanies.map((company) => ({
      company,
      rendered:
        renderCompanyTemplate(
          previewTemplate,
          company.summary,
          previewTemplateList,
          [],
          PREVIEW_SAMPLE_CONTACT
        ) || tmpl,
    }));
  }, [formData.template, previewCompanies, previewTemplate, previewTemplateList]);

  // Estimate length by expanding ${variables}. Start from the rendered preview
  // (so company-specific fields get real values), then substitute any leftover
  // chip variables with their sample labels, then replace anything still
  // unresolved with a generic short placeholder so the count is realistic.
  const estimateText = useMemo(() => {
    const tmpl = formData.template.trim();
    if (!tmpl) return '';
    const base = renderedPreviews[0]?.rendered || tmpl;
    const chips = [...FUNDRAISING_CHIPS, ...B2B_CHIPS];
    const seen = new Set<string>();
    const expanded = chips.reduce((acc, { variable, sampleLabel }) => {
      if (seen.has(variable)) return acc;
      seen.add(variable);
      return acc.split(variable).join(sampleLabel);
    }, base);
    return expanded.replace(/\$\{[^}]+\}/g, 'sample');
  }, [formData.template, renderedPreviews]);

  const handleChipClick = (variable: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const current = formData.template;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const newValue = before + variable + after;

    setFormData({ ...formData, template: newValue });

    // Restore cursor position after React commits the update; keep focus on textarea
    const newCursorPos = start + variable.length;
    setTimeout(() => {
      textarea.setSelectionRange(newCursorPos, newCursorPos);
      textarea.focus();
    }, 0);
  };

  // Initialize form data when modal opens or editing template changes
  useEffect(() => {
    if (isOpen) {
      if (editingTemplate) {
        const channel = channelOptions.includes(editingTemplate.channel)
          ? editingTemplate.channel
          : channelOptions[0];
        const settings = editingTemplate.settings || {};
        setFormData({
          title: (editingTemplate.title || '').trim(),
          channel,
          template: (editingTemplate.template || '').trim(),
          category: (editingTemplate.category || '').trim(),
          variableDefaults: { ...(settings.variable_defaults || {}) },
          fallbackTemplateId: settings.fallback_template_id || '',
        });
      } else {
        setFormData({
          title: '',
          channel: channelOptions.includes(defaultChannel) ? defaultChannel : channelOptions[0],
          template: '',
          category: '',
          variableDefaults: {},
          fallbackTemplateId: '',
        });
      }
    }
  }, [isOpen, editingTemplate, defaultChannel, channelOptions]);

  const handleSubmit = async () => {
    if (!formData.title.trim()) {
      showToast('Please enter a title for the template.');
      focusAndScrollTo(titleInputRef.current);
      return;
    }

    if (!formData.template.trim()) {
      showToast('Please enter a template message.');
      focusAndScrollTo(textareaRef.current);
      return;
    }

    setIsSubmitting(true);
    try {
      const categoryVal = formData.category.trim() || undefined;
      // Only keep defaults for variables that the current template still uses,
      // and drop entries with an empty value so the JSON stays clean.
      const trimmedDefaults: Record<string, string> = {};
      for (const v of usedVariables) {
        const val = (formData.variableDefaults[v] ?? '').toString();
        if (val.trim().length > 0) trimmedDefaults[v] = val;
      }
      const settings: MessageTemplateSettings = {
        variable_defaults: trimmedDefaults,
        fallback_template_id: formData.fallbackTemplateId || null,
      };
      if (isCreating && editingTemplate === null) {
        await onCreate({
          title: formData.title.trim(),
          channel: formData.channel,
          template: formData.template.trim(),
          category: categoryVal,
          settings,
        });
      } else if (editingTemplate) {
        await onUpdate(editingTemplate.id, {
          title: formData.title.trim(),
          channel: formData.channel,
          template: formData.template.trim(),
          category: categoryVal,
          settings,
        });
      }
      onClose();
    } catch (error: any) {
      showToast(`Error ${isCreating ? 'creating' : 'updating'} template: ${error.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      setFormData({
        title: '',
        channel: 'direct',
        template: '',
        category: '',
        variableDefaults: {},
        fallbackTemplateId: '',
      });
      onClose();
    }
  };

  // Other templates the user can choose as a fallback (excluding self).
  const fallbackChoices = useMemo(
    () => allTemplates.filter((t) => t.id !== editingTemplate?.id),
    [allTemplates, editingTemplate?.id]
  );

  const selectedFallback = useMemo(
    () => fallbackChoices.find((t) => t.id === formData.fallbackTemplateId) || null,
    [fallbackChoices, formData.fallbackTemplateId]
  );

  // Custom dropdown state + outside-click handling for the fallback picker.
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const fallbackContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fallbackOpen) return;
    const handler = (e: MouseEvent) => {
      if (!fallbackContainerRef.current) return;
      if (!fallbackContainerRef.current.contains(e.target as Node)) {
        setFallbackOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [fallbackOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl max-w-5xl w-full mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">
            {isCreating ? 'Create New Template' : 'Edit Template'}
          </h2>
          <button
            onClick={handleClose}
            disabled={isSubmitting}
            className="text-gray-400 hover:text-gray-600 focus:outline-none disabled:opacity-50"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Channel
              </label>
              <select
                value={formData.channel}
                onChange={(e) => setFormData({ ...formData, channel: e.target.value as TemplateChannel })}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                disabled={isSubmitting}
              >
                {channelOptions.map((ch) => (
                  <option key={ch} value={ch}>
                    {CHANNEL_LABELS[ch]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Category <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <select
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                disabled={isSubmitting}
              >
                <option value="">None</option>
                <option value="Consumer">Consumer</option>
                <option value="Entertainment">Entertainment</option>
                <option value="Software">Software</option>
                <option value="Partner">Partner</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Title
            </label>
            <input
              ref={titleInputRef}
              type="text"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: toPlainText(e.target.value) })}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              placeholder="e.g., Sequence 1"
              disabled={isSubmitting}
            />
          </div>

          <div>
            <label className="flex items-center justify-between gap-2 text-sm font-medium text-gray-700 mb-2">
              <span>Template</span>
              <span className="text-gray-400 font-normal text-xs shrink-0">
                {estimateText
                  ? (() => {
                      const words = estimateText.split(/\s+/).filter(Boolean).length;
                      const chars = estimateText.length;
                      const sec = Math.ceil(words / 3.5);
                      return `~${words} word${words !== 1 ? 's' : ''} · ~${chars} char${chars !== 1 ? 's' : ''} · ~${sec < 60 ? `${sec}s` : `${Math.ceil(sec / 60)}m`} reading time`;
                    })()
                  : '—'}
              </span>
            </label>
            <textarea
              ref={textareaRef}
              value={formData.template}
              onChange={(e) => setFormData({ ...formData, template: toPlainText(e.target.value) })}
              rows={12}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm"
              placeholder={`Just visited your page - \${salesOpenerSentence} We can create KILLER product photos/videos for your \${PRODUCT1} products using AI, and have worked with top brands like Polki Stories, Onya, and Armuse. Worth a chat?`}
              disabled={isSubmitting}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {getVariableChips(primaryUse).map(({ variable, sampleLabel }) => (
                <button
                  key={variable}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleChipClick(variable);
                  }}
                  disabled={isSubmitting}
                  className="inline-flex flex-col items-start px-2.5 py-1.5 rounded-md text-left bg-gray-50 text-gray-700 hover:bg-indigo-50 hover:text-indigo-800 border border-gray-200 hover:border-indigo-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title={`Insert ${variable}\nSample Value: ${sampleLabel}`}
                >
                  <span className="font-mono text-xs text-gray-600">{variable}</span>
                  <span className="text-[11px] text-gray-400 mt-0.5 max-w-[100px] truncate">{sampleLabel}</span>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-gray-400">
              Follow-up dates skip weekends and holidays.
            </p>
          </div>

          {/* Defaults for variables this template uses */}
          {usedVariables.length > 0 && (
            <div className="border-t border-gray-200 pt-4">
              <div className="flex items-baseline justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  Variable defaults
                </label>
                <span className="text-xs text-gray-400">
                  Used when a company is missing a value. Can reference other ${'${variables}'}.
                </span>
              </div>
              <div className="space-y-2">
                {usedVariables.map((variable) => (
                  <div key={variable} className="flex items-center gap-2">
                    <span className="font-mono text-xs text-gray-600 w-44 shrink-0 truncate" title={variable}>
                      {'${' + variable + '}'}
                    </span>
                    <input
                      type="text"
                      value={formData.variableDefaults[variable] ?? ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          variableDefaults: {
                            ...formData.variableDefaults,
                            [variable]: toPlainText(e.target.value),
                          },
                        })
                      }
                      placeholder="(no default, e.g. ${brand_name} or hello there)"
                      disabled={isSubmitting}
                      className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Fallback template */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Fallback template <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <div ref={fallbackContainerRef} className="relative">
              <button
                type="button"
                onClick={() => setFallbackOpen((v) => !v)}
                disabled={isSubmitting}
                className="w-full text-left px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {selectedFallback ? (
                  <div className="flex flex-col">
                    <span className="text-sm text-gray-900 truncate">
                      {(selectedFallback.title || 'Untitled')}{' '}
                      <span className="text-xs text-gray-500 font-normal">
                        — {CHANNEL_LABELS[selectedFallback.channel]}
                      </span>
                    </span>
                    <span className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                      {previewSnippet(selectedFallback.template)}
                    </span>
                  </div>
                ) : (
                  <span className="text-sm text-gray-500">None</span>
                )}
                <svg
                  className="absolute right-2 top-3 w-4 h-4 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {fallbackOpen && (
                <div className="absolute z-20 bottom-full mb-1 w-full max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setFormData({ ...formData, fallbackTemplateId: '' });
                      setFallbackOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 border-b border-gray-100 ${
                      formData.fallbackTemplateId === '' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700'
                    }`}
                  >
                    None
                  </button>
                  {fallbackChoices.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-gray-400">
                      No other templates available. Create another template first.
                    </div>
                  ) : (
                    fallbackChoices.map((t) => {
                      const isSelected = formData.fallbackTemplateId === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setFormData({ ...formData, fallbackTemplateId: t.id });
                            setFallbackOpen(false);
                          }}
                          className={`w-full text-left px-3 py-2 hover:bg-indigo-50 border-b border-gray-100 last:border-b-0 ${
                            isSelected ? 'bg-indigo-50' : ''
                          }`}
                        >
                          <div className="flex items-baseline gap-2">
                            <span className={`text-sm font-medium truncate ${isSelected ? 'text-indigo-700' : 'text-gray-900'}`}>
                              {t.title || 'Untitled'}
                            </span>
                            <span className="text-[11px] text-gray-500 shrink-0">
                              {CHANNEL_LABELS[t.channel]}
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5 whitespace-pre-line line-clamp-3">
                            {previewSnippet(t.template)}
                          </p>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
            <p className="mt-1 text-xs text-gray-400">
              Rendered instead of this template if a company-fetched variable above has no
              value and no default. Built-in fields (follow-up dates) are always available
              and never trigger the fallback.
            </p>
          </div>

          <div className="flex items-center gap-3 pt-4">
            <button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Saving...' : isCreating ? 'Create' : 'Update'}
            </button>
            <button
              onClick={handleClose}
              disabled={isSubmitting}
              className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        </div>

        {/* Live Preview Pane */}
        <aside className="border border-gray-200 rounded-lg bg-gray-50 overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-gray-200 bg-white">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">Live Preview</h3>
              <span className="text-xs text-gray-500">
                {previewCompaniesLoading
                  ? 'Loading…'
                  : `${previewCompanies.length} compan${previewCompanies.length === 1 ? 'y' : 'ies'}`}
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              How this template renders with real data.
            </p>
          </div>

          {previewCompanies.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              {previewCompaniesLoading
                ? 'Fetching companies…'
                : 'No companies with summary data yet.'}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-3 space-y-3 max-h-[70vh]">
              {!formData.template.trim() ? (
                <div className="text-sm text-gray-400 text-center py-12">
                  Start typing to see previews…
                </div>
              ) : (
                renderedPreviews.map(({ company, rendered }) => (
                  <div
                    key={company.id}
                    className="bg-white rounded-md border border-gray-200 overflow-hidden"
                  >
                    <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 text-[11px] font-medium text-gray-700 truncate">
                      {getCompanyLabel(company)}
                    </div>
                    <pre className="text-xs text-gray-800 whitespace-pre-wrap font-sans p-3">
                      {rendered}
                    </pre>
                  </div>
                ))
              )}
            </div>
          )}
        </aside>
        </div>
      </div>
      <Toast
        message={toastMessage}
        isVisible={toastVisible}
        type={toastType}
        onClose={() => setToastVisible(false)}
        duration={2500}
      />
    </div>
  );
};

export default MessageTemplateModal;
