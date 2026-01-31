'use client';

import { useState, useMemo, useEffect } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useMessageTemplates, MessageTemplate, TemplateChannel, CHANNEL_LABELS } from '@/contexts/MessageTemplatesContext';
import { useOnboarding } from '@/contexts/OnboardingContext';
import DeleteConfirmationModal from '@/components/ui/DeleteConfirmationModal';
import MessageTemplateModal from '@/components/ui/MessageTemplateModal';
import { fetchGenerateMessages } from '@/lib/api';

const B2B_CHANNELS: TemplateChannel[] = ['direct', 'instagram'];
const FUNDRAISING_CHANNELS: TemplateChannel[] = ['email', 'linkedin', 'direct', 'instagram'];

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

function TemplatesContent() {
  const { templates, loading, createTemplate, updateTemplate, deleteTemplate } = useMessageTemplates();
  const { onboarding } = useOnboarding();
  const primaryUse = onboarding?.flowType ?? onboarding?.step0?.primaryUse ?? 'fundraising';
  const channelOptions = primaryUse === 'b2b' ? B2B_CHANNELS : FUNDRAISING_CHANNELS;
  const [activeTab, setActiveTab] = useState<TemplateChannel>(channelOptions[0]);

  // Sync activeTab when channelOptions change (e.g. onboarding loads or primaryUse changes)
  useEffect(() => {
    if (!channelOptions.includes(activeTab)) {
      setActiveTab(channelOptions[0]);
    }
  }, [channelOptions, activeTab]);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

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

  const handleCreate = async (data: { title: string; channel: TemplateChannel; template: string }) => {
    await createTemplate(data);
  };

  const handleUpdate = async (id: string, data: { title: string; channel: TemplateChannel; template: string }) => {
    await updateTemplate(id, data);
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
    // First filter by active tab channel
    const filteredTemplates = templates.filter(t => t.channel === activeTab);
    
    // Then sort by number in title
    return [...filteredTemplates].sort((a, b) => {
      const titleA = a.title || '';
      const titleB = b.title || '';
      
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
  }, [templates, activeTab]);

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">Message Templates</h1>
        <button
          onClick={handleCreateClick}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          Create Template
        </button>
      </div>

      {/* Tabs */}
      <div className="mb-6 border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
          {channelOptions.map((ch) => (
            <button
              key={ch}
              onClick={() => setActiveTab(ch)}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === ch
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {CHANNEL_LABELS[ch]}
            </button>
          ))}
        </nav>
      </div>

      {/* Templates List */}
      {sortedTemplates.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
          <p className="text-gray-500 mb-4">
            No {activeTab} templates found. Create your first template to get started.
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
          {sortedTemplates.map((template) => (
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

              <div className="bg-gray-50 rounded-md p-4">
                {template.template ? (
                  <pre className="text-sm text-gray-800 whitespace-pre-wrap font-mono overflow-x-auto">
                    {template.template}
                  </pre>
                ) : (
                  <p className="text-sm text-gray-500">No template defined</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Message Template Modal */}
      <MessageTemplateModal
        isOpen={isModalOpen}
        isCreating={isCreating}
        editingTemplate={editingTemplate}
        defaultChannel={activeTab}
        channelOptions={channelOptions}
        primaryUse={primaryUse}
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
