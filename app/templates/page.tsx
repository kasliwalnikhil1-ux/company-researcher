'use client';

import { useState, useMemo, useEffect } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useMessageTemplates, MessageTemplate, TemplateChannel, CHANNEL_LABELS, PreviewCompany } from '@/contexts/MessageTemplatesContext';
import { useOnboarding } from '@/contexts/OnboardingContext';
import DeleteConfirmationModal from '@/components/ui/DeleteConfirmationModal';
import MessageTemplateModal from '@/components/ui/MessageTemplateModal';
import { fetchGenerateMessages } from '@/lib/api';
import { renderCompanyTemplate } from '@/lib/messageTemplates';

const B2B_CHANNELS: TemplateChannel[] = ['email', 'linkedin', 'direct', 'instagram'];
const FUNDRAISING_CHANNELS: TemplateChannel[] = ['email', 'linkedin', 'direct', 'instagram'];

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

  // If the active channel tab no longer has any templates, fall back to "All".
  useEffect(() => {
    if (activeTab !== 'all' && !visibleChannelOptions.includes(activeTab)) {
      setActiveTab('all');
    }
  }, [visibleChannelOptions, activeTab]);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [selectedPreviewIndex, setSelectedPreviewIndex] = useState(0);

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
    setIsModalOpen(true);
  };

  const handleEditClick = (template: MessageTemplate) => {
    setIsCreating(false);
    setEditingTemplate(template);
    setIsModalOpen(true);
  };

  const handleModalClose = () => {
    setIsModalOpen(false);
    setIsCreating(false);
    setEditingTemplate(null);
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

  // Filter and sort templates by channel and number in title (e.g., "Message 1", "Message 2")
  const sortedTemplates = useMemo(() => {
    // First filter by active tab channel (or show all)
    const filteredTemplates = activeTab === 'all'
      ? templates
      : templates.filter(t => t.channel === activeTab);

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
  }, [templates, activeTab, channelOptions]);

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
        <button
          onClick={handleCreateClick}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          Create Template
        </button>
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
              ? renderCompanyTemplate(template, selectedPreviewCompany.summary, templates) || ''
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
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleEditClick(template)}
                      className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Edit
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
