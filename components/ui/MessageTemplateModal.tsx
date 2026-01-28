"use client";

import React, { useState, useEffect } from 'react';
import { MessageTemplate } from '@/contexts/MessageTemplatesContext';

interface MessageTemplateModalProps {
  isOpen: boolean;
  isCreating: boolean;
  editingTemplate: MessageTemplate | null;
  defaultChannel: 'direct' | 'instagram';
  onClose: () => void;
  onCreate: (data: { title: string; channel: 'direct' | 'instagram'; template: string }) => Promise<void>;
  onUpdate: (id: string, data: { title: string; channel: 'direct' | 'instagram'; template: string }) => Promise<void>;
}

const MessageTemplateModal: React.FC<MessageTemplateModalProps> = ({
  isOpen,
  isCreating,
  editingTemplate,
  defaultChannel,
  onClose,
  onCreate,
  onUpdate,
}) => {
  const [formData, setFormData] = useState<{
    title: string;
    channel: 'direct' | 'instagram';
    template: string;
  }>({
    title: '',
    channel: 'direct',
    template: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize form data when modal opens or editing template changes
  useEffect(() => {
    if (isOpen) {
      if (editingTemplate) {
        setFormData({
          title: (editingTemplate.title || '').trim(),
          channel: editingTemplate.channel,
          template: (editingTemplate.template || '').trim(),
        });
      } else {
        setFormData({
          title: '',
          channel: defaultChannel,
          template: '',
        });
      }
    }
  }, [isOpen, editingTemplate, defaultChannel]);

  const handleSubmit = async () => {
    if (!formData.title.trim()) {
      alert('Please enter a title for the template.');
      return;
    }

    if (!formData.template.trim()) {
      alert('Please enter a template message.');
      return;
    }

    setIsSubmitting(true);
    try {
      if (isCreating && editingTemplate === null) {
        await onCreate({
          title: formData.title.trim(),
          channel: formData.channel,
          template: formData.template.trim(),
        });
      } else if (editingTemplate) {
        await onUpdate(editingTemplate.id, {
          title: formData.title.trim(),
          channel: formData.channel,
          template: formData.template.trim(),
        });
      }
      onClose();
    } catch (error: any) {
      alert(`Error ${isCreating ? 'creating' : 'updating'} template: ${error.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      setFormData({ title: '', channel: 'direct', template: '' });
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 p-6 max-h-[90vh] overflow-y-auto">
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
            />
            <p className="mt-1 text-xs text-gray-500">
              Enter your template message. Use $&#123;variable&#125; syntax for variables like $&#123;PRODUCT1&#125;, $&#123;salesOpenerSentence&#125;, $&#123;product_types&#125;, $&#123;followUpFullDate&#125;, etc.
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Available date placeholders: $&#123;followUpFullDate&#125; (e.g., "Tuesday, Jan 15"), $&#123;followUpWeekdayDate&#125; (e.g., "Tuesday Jan 15"), $&#123;followUpShortDay&#125; (e.g., "Tue"), $&#123;followUpRelativeDay&#125; (e.g., "this Tuesday"), $&#123;followUpRelativeShortDay&#125; (e.g., "this Tue"), $&#123;followUpDateOnly&#125; (e.g., "Jan 15")
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Note: Follow-up dates automatically skip weekends and holidays for business-appropriate scheduling.
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
      </div>
    </div>
  );
};

export default MessageTemplateModal;
