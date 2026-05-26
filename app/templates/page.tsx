'use client';

import { useState, useMemo, useEffect } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useMessageTemplates, MessageTemplate, TemplateChannel, CHANNEL_LABELS, PreviewCompany } from '@/contexts/MessageTemplatesContext';
import { useOnboarding } from '@/contexts/OnboardingContext';
import DeleteConfirmationModal from '@/components/ui/DeleteConfirmationModal';
import MessageTemplateModal from '@/components/ui/MessageTemplateModal';
import { fetchGenerateMessages } from '@/lib/api';
import { renderCompanyTemplate, OFFER_OPTIONS, getOfferLabel } from '@/lib/messageTemplates';

// Color classes per offer key. Extend when new offers are added to OFFER_OPTIONS.
const OFFER_BADGE_CLASSES: Record<string, string> = {
  saas_photoshoots: 'bg-emerald-100 text-emerald-800',
  video_agency: 'bg-amber-100 text-amber-800',
};
const OFFER_PILL_ACTIVE_CLASSES: Record<string, string> = {
  saas_photoshoots: 'bg-emerald-600 text-white border-emerald-600',
  video_agency: 'bg-amber-600 text-white border-amber-600',
};
const OFFER_PILL_FALLBACK_ACTIVE = 'bg-indigo-600 text-white border-indigo-600';

const B2B_CHANNELS: TemplateChannel[] = ['email', 'linkedin', 'direct', 'instagram', 'ads', 'jobs', 'news', 'replies'];
const FUNDRAISING_CHANNELS: TemplateChannel[] = ['email', 'linkedin', 'direct', 'instagram'];

// Sample contact used for the preview column so `${first_name}` shows a value
// even before a real recipient is selected in the company drawer.
const PREVIEW_SAMPLE_CONTACT = { first_name: 'Alex', last_name: 'Morgan', full_name: 'Alex Morgan' };

type TemplateTab = 'all' | TemplateChannel;

export default function TemplatesPage() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          <TemplatesContent />
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

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

function TemplatesContent() {
  const {
    templates,
    loading,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    previewCompanies,
    previewCompaniesLoading,
  } = useMessageTemplates();
  const { onboarding } = useOnboarding();
  const primaryUse = onboarding?.flowType ?? onboarding?.step0?.primaryUse ?? 'fundraising';
  const channelOptions = primaryUse === 'b2b' ? B2B_CHANNELS : FUNDRAISING_CHANNELS;
  const visibleChannelOptions = useMemo(
    () => channelOptions.filter((ch) => templates.some((t) => t.channel === ch)),
    [channelOptions, templates]
  );
  const tabOptions = useMemo<TemplateTab[]>(
    () => ['all', ...visibleChannelOptions],
    [visibleChannelOptions]
  );
  const [activeTab, setActiveTab] = useState<TemplateTab>('all');
  // 'all' | offer key (e.g. 'saas_photoshoots'). Only meaningful when b2b.
  // Defaults to 'saas_photoshoots'; restored from localStorage on mount.
  const ACTIVE_OFFER_STORAGE_KEY = 'templates.activeOffer';
  const [activeOffer, setActiveOffer] = useState<string>('saas_photoshoots');

  // Restore last-selected offer from localStorage on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(ACTIVE_OFFER_STORAGE_KEY);
      if (stored) setActiveOffer(stored);
    } catch {
      // Ignore storage access errors (private mode, etc.)
    }
  }, []);

  // Persist offer selection whenever it changes (b2b only — fundraising forces 'all' below).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (primaryUse !== 'b2b') return;
    try {
      window.localStorage.setItem(ACTIVE_OFFER_STORAGE_KEY, activeOffer);
    } catch {
      // Ignore storage access errors
    }
  }, [activeOffer, primaryUse]);

  // If the active channel tab no longer has any templates, fall back to "All".
  useEffect(() => {
    if (activeTab !== 'all' && !visibleChannelOptions.includes(activeTab)) {
      setActiveTab('all');
    }
  }, [visibleChannelOptions, activeTab]);

  // Reset offer filter when the user is no longer on b2b.
  useEffect(() => {
    if (primaryUse !== 'b2b' && activeOffer !== 'all') {
      setActiveOffer('all');
    }
  }, [primaryUse, activeOffer]);

  // All defined offers (b2b only). Shown even when no templates use them yet so
  // the user can always switch back to the default selection.
  const visibleOffers = useMemo(() => {
    if (primaryUse !== 'b2b') return [] as string[];
    return Object.keys(OFFER_OPTIONS);
  }, [primaryUse]);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  // Set when the user clicks Duplicate on a template card — opens the modal in
  // create mode but pre-filled from this source.
  const [prefillTemplate, setPrefillTemplate] = useState<MessageTemplate | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [selectedPreviewIndex, setSelectedPreviewIndex] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [openCopyMenu, setOpenCopyMenu] = useState<string | null>(null);

  useEffect(() => {
    if (!openCopyMenu) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-copy-menu]')) {
        setOpenCopyMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [openCopyMenu]);

  useEffect(() => {
    if (selectedPreviewIndex >= previewCompanies.length && previewCompanies.length > 0) {
      setSelectedPreviewIndex(0);
    }
  }, [previewCompanies, selectedPreviewIndex]);

  const selectedPreviewCompany = previewCompanies[selectedPreviewIndex] || null;

  const handleGenerateMessages = async () => {
    setGenerating(true);
    try {
      const result = await fetchGenerateMessages(onboarding ?? undefined);
      if (result?.error) {
        alert(result.error);
        return;
      }
      if (!result?.subjectline || !result?.email1 || !result?.email2) {
        alert('Could not generate messages. Please try again.');
        return;
      }
      await createTemplate({ title: 'Subject', channel: 'email', template: result.subjectline });
      await createTemplate({ title: 'Sequence 1', channel: 'email', template: result.email1 });
      await createTemplate({ title: 'Sequence 2', channel: 'email', template: result.email2 });
      if (channelOptions.includes('email')) {
        setActiveTab('email');
      } else {
        setActiveTab(channelOptions[0]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate messages';
      alert(msg);
    } finally {
      setGenerating(false);
    }
  };

  const handleCreateClick = () => {
    setIsCreating(true);
    setEditingTemplate(null);
    setPrefillTemplate(null);
    setIsModalOpen(true);
  };

  const handleEditClick = (template: MessageTemplate) => {
    setIsCreating(false);
    setEditingTemplate(template);
    setPrefillTemplate(null);
    setIsModalOpen(true);
  };

  const handleDuplicateClick = (template: MessageTemplate) => {
    setIsCreating(true);
    setEditingTemplate(null);
    // Suffix the title so the user sees this is a fresh copy, not an edit.
    const suffixed = /\(Copy\)\s*$/i.test(template.title || '')
      ? template
      : { ...template, title: `${template.title || 'Untitled'} (Copy)` };
    setPrefillTemplate(suffixed);
    setIsModalOpen(true);
  };

  const handleModalClose = () => {
    setIsModalOpen(false);
    setIsCreating(false);
    setEditingTemplate(null);
    setPrefillTemplate(null);
  };

  const handleCreate = async (data: Parameters<typeof createTemplate>[0]) => {
    await createTemplate(data);
    setActiveTab(data.channel);
  };

  const handleUpdate = async (id: string, data: Parameters<typeof updateTemplate>[1]) => {
    await updateTemplate(id, data);
    if (data.channel) setActiveTab(data.channel);
  };

  const handleDeleteClick = (id: string) => {
    setTemplateToDelete(id);
    setDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!templateToDelete) return;

    try {
      await deleteTemplate(templateToDelete);
      setDeleteModalOpen(false);
      setTemplateToDelete(null);
    } catch (error: any) {
      alert(`Error deleting template: ${error.message}`);
      setDeleteModalOpen(false);
      setTemplateToDelete(null);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteModalOpen(false);
    setTemplateToDelete(null);
  };

  const formatTemplateForCopy = (template: MessageTemplate, index?: number): string => {
    const header = [
      template.title || `${CHANNEL_LABELS[template.channel]} Template`,
      CHANNEL_LABELS[template.channel],
      template.category || '—',
    ].join(' - ');
    const prefix = typeof index === 'number' ? `${index + 1}: ` : '';
    const body = template.template || '(No template defined)';
    const filled = selectedPreviewCompany && template.template
      ? renderCompanyTemplate(template, selectedPreviewCompany.summary, templates, [], PREVIEW_SAMPLE_CONTACT) || body
      : '(No preview company selected)';
    const sampleLabel = selectedPreviewCompany
      ? `Filled Template on sample (${getCompanyLabel(selectedPreviewCompany)}):`
      : 'Filled Template on sample:';
    return `${prefix}${header}\n${body}\n\n${sampleLabel}\n${filled}`;
  };

  const formatPreviewOnlyForCopy = (template: MessageTemplate, index?: number): string => {
    if (!template.template) return '';
    const header = [
      template.title || `${CHANNEL_LABELS[template.channel]} Template`,
      CHANNEL_LABELS[template.channel],
      template.category || '—',
    ].join(' - ');
    const prefix = typeof index === 'number' ? `${index + 1}: ` : '';
    const filled = selectedPreviewCompany
      ? renderCompanyTemplate(template, selectedPreviewCompany.summary, templates, [], PREVIEW_SAMPLE_CONTACT) || template.template
      : template.template;
    return `${prefix}${header}\n${filled}`;
  };

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  const handleCopyTemplate = async (template: MessageTemplate) => {
    const ok = await copyToClipboard(formatTemplateForCopy(template));
    if (ok) {
      setCopiedId(template.id);
      setTimeout(() => setCopiedId((prev) => (prev === template.id ? null : prev)), 1500);
    }
  };

  const handleCopyPreviewOnly = async (template: MessageTemplate) => {
    const text = formatPreviewOnlyForCopy(template);
    if (!text) return;
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedId(template.id);
      setTimeout(() => setCopiedId((prev) => (prev === template.id ? null : prev)), 1500);
    }
  };

  // Filter and sort templates by channel and number in title (e.g., "Message 1", "Message 2")
  const sortedTemplates = useMemo(() => {
    // First filter by active tab channel (or show all)
    let filteredTemplates = activeTab === 'all'
      ? templates
      : templates.filter(t => t.channel === activeTab);

    // Then filter by selected offer (b2b only).
    if (primaryUse === 'b2b' && activeOffer !== 'all') {
      filteredTemplates = filteredTemplates.filter(t => (t.offer || '') === activeOffer);
    }

    // Then sort by number in title
    return [...filteredTemplates].sort((a, b) => {
      const titleA = a.title || '';
      const titleB = b.title || '';

      // When viewing All, group by channel first (using channelOptions order)
      if (activeTab === 'all' && a.channel !== b.channel) {
        const idxA = channelOptions.indexOf(a.channel);
        const idxB = channelOptions.indexOf(b.channel);
        const safeA = idxA === -1 ? Number.MAX_SAFE_INTEGER : idxA;
        const safeB = idxB === -1 ? Number.MAX_SAFE_INTEGER : idxB;
        return safeA - safeB;
      }

      // For email channel (or email-grouped rows in All), put Subject first
      if (activeTab === 'email' || (activeTab === 'all' && a.channel === 'email')) {
        const aIsSubject = /\bsubject\b/i.test(titleA);
        const bIsSubject = /\bsubject\b/i.test(titleB);
        if (aIsSubject && !bIsSubject) return -1;
        if (!aIsSubject && bIsSubject) return 1;
        if (aIsSubject && bIsSubject) return 0;
      }
      
      // Extract number from titles like "Message 1", "Message 2", etc.
      const matchA = titleA.match(/Message\s+(\d+)/i);
      const matchB = titleB.match(/Message\s+(\d+)/i);
      
      const numA = matchA ? parseInt(matchA[1], 10) : null;
      const numB = matchB ? parseInt(matchB[1], 10) : null;
      
      // If both have numbers, sort by number
      if (numA !== null && numB !== null) {
        return numA - numB;
      }
      
      // If only one has a number, put the one without number first
      if (numA === null && numB !== null) {
        return -1;
      }
      if (numA !== null && numB === null) {
        return 1;
      }
      
      // If neither has a number, sort alphabetically
      return titleA.localeCompare(titleB);
    });
  }, [templates, activeTab, channelOptions, primaryUse, activeOffer]);

  // Count `${var}` occurrences across the templates currently shown under the
  // active tab, and collect the distinct per-template defaults for each var
  // from `template.settings.variable_defaults`.
  const variableUsage = useMemo(() => {
    const counts: Record<string, number> = {};
    const defaults: Record<string, Set<string>> = {};
    const regex = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
    for (const t of sortedTemplates) {
      if (!t.template) continue;
      const tplDefaults = t.settings?.variable_defaults || {};
      const seenInThisTemplate = new Set<string>();
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(t.template)) !== null) {
        const name = m[1];
        counts[name] = (counts[name] || 0) + 1;
        if (!seenInThisTemplate.has(name)) {
          seenInThisTemplate.add(name);
          const def = tplDefaults[name];
          if (typeof def === 'string' && def.trim()) {
            if (!defaults[name]) defaults[name] = new Set();
            defaults[name].add(def);
          }
        }
      }
    }
    return Object.entries(counts)
      .map(([name, count]) => ({
        name,
        count,
        defaults: defaults[name] ? Array.from(defaults[name]) : [],
      }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      });
  }, [sortedTemplates]);

  const handleCopyAll = async () => {
    if (sortedTemplates.length === 0) return;
    const text = sortedTemplates
      .map((t, idx) => formatTemplateForCopy(t, idx))
      .join('\n\n---\n\n');
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    }
  };

  const handleCopyAllPreviewOnly = async () => {
    if (sortedTemplates.length === 0) return;
    const text = sortedTemplates
      .map((t, idx) => formatPreviewOnlyForCopy(t, idx))
      .filter(Boolean)
      .join('\n\n---\n\n');
    if (!text) return;
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-3.5rem)] md:min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">Message Templates</h1>
        <div className="flex items-center gap-2">
          <div className="relative" data-copy-menu>
            <button
              onClick={() =>
                setOpenCopyMenu(openCopyMenu === '__all__' ? null : '__all__')
              }
              disabled={sortedTemplates.length === 0}
              className="inline-flex items-center gap-1 px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {copiedAll ? 'Copied!' : 'Copy All'}
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {openCopyMenu === '__all__' && (
              <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-md shadow-lg z-20 py-1">
                <button
                  onClick={() => {
                    setOpenCopyMenu(null);
                    handleCopyAll();
                  }}
                  className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Copy with template
                </button>
                <button
                  onClick={() => {
                    setOpenCopyMenu(null);
                    handleCopyAllPreviewOnly();
                  }}
                  className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Copy preview only
                </button>
              </div>
            )}
          </div>
          <button
            onClick={handleCreateClick}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            Create Template
          </button>
        </div>
      </div>

      {/* Tabs + Preview Company Selector */}
      <div className="mb-6 border-b border-gray-200 flex items-end justify-between gap-4">
        <nav className="-mb-px flex space-x-8">
          {tabOptions.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === tab
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab === 'all' ? 'All' : CHANNEL_LABELS[tab]}
            </button>
          ))}
        </nav>
        {previewCompanies.length > 0 && (
          <div className="pb-3 flex items-center gap-2">
            <span className="text-xs text-gray-500">Preview with</span>
            <select
              value={selectedPreviewIndex}
              onChange={(e) => setSelectedPreviewIndex(parseInt(e.target.value, 10))}
              className="px-2 py-1 text-sm border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            >
              {previewCompanies.map((c, idx) => (
                <option key={c.id} value={idx}>
                  {getCompanyLabel(c)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Offer filter (b2b only) */}
      {primaryUse === 'b2b' && visibleOffers.length > 0 && (
        <div className="mb-6 flex items-center flex-wrap gap-2">
          <span className="text-xs font-medium text-gray-500 mr-1">Offer:</span>
          {([...visibleOffers, 'all'] as string[]).map((key) => {
            const label = key === 'all' ? 'All' : getOfferLabel(key);
            const isActive = activeOffer === key;
            const activeClass =
              key === 'all'
                ? OFFER_PILL_FALLBACK_ACTIVE
                : OFFER_PILL_ACTIVE_CLASSES[key] ?? OFFER_PILL_FALLBACK_ACTIVE;
            return (
              <button
                key={key}
                onClick={() => setActiveOffer(key)}
                className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                  isActive
                    ? activeClass
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Variable Usage Summary */}
      {variableUsage.length > 0 && (
        <div className="mb-6 bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs font-medium text-gray-500 mb-3">
            Variables used in {activeTab === 'all' ? 'all templates' : `${CHANNEL_LABELS[activeTab]} templates`}
            <span className="ml-2 text-gray-400">
              ({variableUsage.length} unique, {variableUsage.reduce((sum, v) => sum + v.count, 0)} total)
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {variableUsage.map(({ name, count, defaults }) => (
              <div
                key={name}
                className="flex items-start gap-2 px-3 py-2 rounded-md bg-gray-50 border border-gray-200"
              >
                <span className="inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1.5 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-semibold flex-shrink-0 mt-0.5">
                  {count}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-mono text-gray-800 truncate">
                    ${'{'}{name}{'}'}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5 truncate" title={defaults.join(' | ')}>
                    {defaults.length === 0 ? (
                      <span className="italic text-gray-400">no default</span>
                    ) : defaults.length === 1 ? (
                      <>default: <span className="text-gray-700">{defaults[0]}</span></>
                    ) : (
                      <>defaults ({defaults.length}): <span className="text-gray-700">{defaults.join(' | ')}</span></>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Templates List */}
      {sortedTemplates.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
          <p className="text-gray-500 mb-4">
            No {activeTab === 'all' ? '' : `${activeTab} `}templates found. Create your first template to get started.
          </p>
          <button
            onClick={handleGenerateMessages}
            disabled={generating}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {generating ? (
              <>
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Generating...
              </>
            ) : (
              'Generate Messages with AI'
            )}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {sortedTemplates.map((template) => {
            const rendered = selectedPreviewCompany && template.template
              ? renderCompanyTemplate(template, selectedPreviewCompany.summary, templates, [], PREVIEW_SAMPLE_CONTACT) || ''
              : '';
            return (
              <div
                key={template.id}
                className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm"
              >
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <div className="flex items-center gap-3">
                      <h3 className="text-lg font-semibold text-gray-900">
                        {template.title || `${CHANNEL_LABELS[template.channel]} Template`}
                      </h3>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                        {CHANNEL_LABELS[template.channel]}
                      </span>
                      {template.category && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                          {template.category}
                        </span>
                      )}
                      {primaryUse === 'b2b' && template.offer && getOfferLabel(template.offer) && (
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            OFFER_BADGE_CLASSES[template.offer] ?? 'bg-gray-100 text-gray-700'
                          }`}
                        >
                          {getOfferLabel(template.offer)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative" data-copy-menu>
                      <button
                        onClick={() =>
                          setOpenCopyMenu(openCopyMenu === template.id ? null : template.id)
                        }
                        className="inline-flex items-center gap-1 px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                      >
                        {copiedId === template.id ? 'Copied!' : 'Copy'}
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {openCopyMenu === template.id && (
                        <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-md shadow-lg z-20 py-1">
                          <button
                            onClick={() => {
                              setOpenCopyMenu(null);
                              handleCopyTemplate(template);
                            }}
                            className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                          >
                            Copy with template
                          </button>
                          <button
                            onClick={() => {
                              setOpenCopyMenu(null);
                              handleCopyPreviewOnly(template);
                            }}
                            className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                          >
                            Copy preview only
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => handleEditClick(template)}
                      className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDuplicateClick(template)}
                      className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Duplicate
                    </button>
                    <button
                      onClick={() => handleDeleteClick(template.id)}
                      className="inline-flex items-center px-3 py-1.5 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
                  <div className="flex flex-col min-w-0">
                    <div className="text-xs font-medium text-gray-500 mb-1.5">Template</div>
                    <div className="bg-gray-50 rounded-md p-4 flex-1">
                      {template.template ? (
                        <pre className="text-sm text-gray-800 whitespace-pre-wrap font-mono overflow-x-auto">
                          {template.template}
                        </pre>
                      ) : (
                        <p className="text-sm text-gray-500">No template defined</p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col min-w-0">
                    <div className="text-xs font-medium text-gray-500 mb-1.5 flex items-center justify-between">
                      <span>Preview</span>
                      {selectedPreviewCompany && (
                        <span className="text-[11px] text-gray-400 truncate ml-2">
                          {getCompanyLabel(selectedPreviewCompany)}
                        </span>
                      )}
                    </div>
                    <div className="bg-indigo-50/40 border border-indigo-100 rounded-md p-4 flex-1">
                      {!template.template ? (
                        <p className="text-sm text-gray-400">No template defined</p>
                      ) : !selectedPreviewCompany ? (
                        <p className="text-sm text-gray-400">
                          {previewCompaniesLoading
                            ? 'Loading companies…'
                            : 'No companies with summary data yet.'}
                        </p>
                      ) : (
                        <pre className="text-sm text-gray-800 whitespace-pre-wrap font-sans overflow-x-auto">
                          {rendered || template.template}
                        </pre>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Message Template Modal */}
      <MessageTemplateModal
        isOpen={isModalOpen}
        isCreating={isCreating}
        editingTemplate={editingTemplate}
        prefillTemplate={prefillTemplate}
        defaultChannel={activeTab === 'all' ? channelOptions[0] : activeTab}
        channelOptions={channelOptions}
        primaryUse={primaryUse}
        previewCompanies={previewCompanies}
        previewCompaniesLoading={previewCompaniesLoading}
        allTemplates={templates}
        onClose={handleModalClose}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
      />

      {/* Delete Confirmation Modal */}
      <DeleteConfirmationModal
        isOpen={deleteModalOpen}
        title="Delete Template"
        message="Are you sure you want to delete this template? This action cannot be undone."
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        confirmText="Delete"
        cancelText="Cancel"
      />
    </div>
  );
}
