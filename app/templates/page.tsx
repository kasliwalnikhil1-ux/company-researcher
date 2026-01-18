'use client';

import { useState, useMemo } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useMessageTemplates, MessageTemplate } from '@/contexts/MessageTemplatesContext';
import DeleteConfirmationModal from '@/components/ui/DeleteConfirmationModal';

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
  const [activeTab, setActiveTab] = useState<'direct' | 'instagram'>('direct');
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<string | null>(null);
  const [formData, setFormData] = useState<{
    title: string;
    channel: 'direct' | 'instagram';
    template: string; // Single template text
  }>({
    title: '',
    channel: 'direct',
    template: '',
  });

  const handleCreate = async () => {
    try {
      if (!formData.title.trim()) {
        alert('Please enter a title for the template.');
        return;
      }

      if (!formData.template.trim()) {
        alert('Please enter a template message.');
        return;
      }

      await createTemplate({
        title: formData.title.trim(),
        channel: formData.channel,
        template: formData.template.trim(),
      });
      
      setIsCreating(false);
      setFormData({ title: '', channel: 'direct', template: '' });
    } catch (error: any) {
      alert(`Error creating template: ${error.message}`);
    }
  };

  const handleUpdate = async (id: string) => {
    try {
      if (!formData.title.trim()) {
        alert('Please enter a title for the template.');
        return;
      }

      if (!formData.template.trim()) {
        alert('Please enter a template message.');
        return;
      }

      await updateTemplate(id, {
        title: formData.title.trim(),
        channel: formData.channel,
        template: formData.template.trim(),
      });
      
      setEditingId(null);
      setFormData({ title: '', channel: 'direct', template: '' });
    } catch (error: any) {
      alert(`Error updating template: ${error.message}`);
    }
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

  const startEditing = (template: MessageTemplate) => {
    setActiveTab(template.channel);
    setEditingId(template.id);
    setFormData({
      title: (template.title || '').trim(),
      channel: template.channel,
      template: (template.template || '').trim(),
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setIsCreating(false);
    setFormData({ title: '', channel: 'direct', template: '' });
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
        {!isCreating && (
          <button
            onClick={() => {
              setIsCreating(true);
              setFormData({ title: '', channel: activeTab, template: '' });
            }}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            Create Template
          </button>
        )}
      </div>

      {/* Tabs */}
      {!isCreating && !editingId && (
        <div className="mb-6 border-b border-gray-200">
          <nav className="-mb-px flex space-x-8">
            <button
              onClick={() => setActiveTab('direct')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'direct'
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Direct
            </button>
            <button
              onClick={() => setActiveTab('instagram')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'instagram'
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Instagram
            </button>
          </nav>
        </div>
      )}

      {/* Create/Edit Form */}
      {(isCreating || editingId) && (
        <div className="mb-8 bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">
            {isCreating ? 'Create New Template' : 'Edit Template'}
          </h2>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Title
              </label>
              <input
                type="text"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="e.g., Instagram Outreach Messages"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Channel
              </label>
              <select
                value={formData.channel}
                onChange={(e) => setFormData({ ...formData, channel: e.target.value as 'direct' | 'instagram' })}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="direct">Direct</option>
                <option value="instagram">Instagram</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Template
              </label>
              <textarea
                value={formData.template}
                onChange={(e) => setFormData({ ...formData, template: e.target.value })}
                rows={12}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm"
                placeholder={`Just visited your page - \${salesOpenerSentence} We can create KILLER product photos/videos for your \${PRODUCT1} products using AI, and have worked with top brands like Polki Stories, Onya, and Armuse. Worth a chat?`}
              />
              <p className="mt-1 text-xs text-gray-500">
                Enter your template message. Use $&#123;variable&#125; syntax for variables like $&#123;PRODUCT1&#125;, $&#123;salesOpenerSentence&#125;, $&#123;product_types&#125;, etc.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => isCreating ? handleCreate() : editingId && handleUpdate(editingId)}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
              >
                {isCreating ? 'Create' : 'Update'}
              </button>
              <button
                onClick={cancelEdit}
                className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Templates List */}
      {sortedTemplates.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
          <p className="text-gray-500 mb-4">
            No {activeTab} templates found. Create your first template to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {sortedTemplates.map((template) => (
            <div
              key={template.id}
              className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm"
            >
              {editingId === template.id ? null : (
                <>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-semibold text-gray-900">
                          {template.title || `${template.channel === 'direct' ? 'Direct' : 'Instagram'} Template`}
                        </h3>
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                          {template.channel === 'direct' ? 'Direct' : 'Instagram'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => startEditing(template)}
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
                </>
              )}
            </div>
          ))}
        </div>
      )}

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
