"use client";

import React, { useState, useEffect, useRef } from 'react';
import { MessageTemplate, TemplateChannel, CHANNEL_LABELS } from '@/contexts/MessageTemplatesContext';

// Chips by primaryUse
const FUNDRAISING_CHIPS: { variable: string; sampleLabel: string }[] = [
  { variable: '${twitter_line}', sampleLabel: 'I just read your tweet about...' },
  { variable: '${line1}', sampleLabel: 'I saw ..., which is why I\'m reaching out to your company.' },
  { variable: '${line2}', sampleLabel: 'I believe ... could greatly benefit us at my company.' },
  { variable: '${cleaned_name}', sampleLabel: 'Accel or John' },
  { variable: '${followUpFullDate}', sampleLabel: 'Tuesday, Jan 15' },
  { variable: '${followUpWeekdayDate}', sampleLabel: 'Tuesday Jan 15' },
  { variable: '${followUpShortDay}', sampleLabel: 'Tue' },
  { variable: '${followUpRelativeDay}', sampleLabel: 'this Tuesday' },
  { variable: '${followUpRelativeShortDay}', sampleLabel: 'this Tue' },
  { variable: '${followUpDateOnly}', sampleLabel: 'Jan 15' },
];

const B2B_CHIPS: { variable: string; sampleLabel: string }[] = [
  { variable: '${PRODUCT1}', sampleLabel: 'jewelry' },
  { variable: '${PRODUCT2}', sampleLabel: 'accessories' },
  { variable: '${salesOpenerSentence}', sampleLabel: 'Loved your latest collection.' },
  { variable: '${product_types}', sampleLabel: 'jewelry and accessories' },
  { variable: '${company_industry}', sampleLabel: 'fashion' },
  { variable: '${profile_industry}', sampleLabel: 'fashion' },
  { variable: '${followUpFullDate}', sampleLabel: 'Tuesday, Jan 15' },
  { variable: '${followUpWeekdayDate}', sampleLabel: 'Tuesday Jan 15' },
  { variable: '${followUpShortDay}', sampleLabel: 'Tue' },
  { variable: '${followUpRelativeDay}', sampleLabel: 'this Tuesday' },
  { variable: '${followUpRelativeShortDay}', sampleLabel: 'this Tue' },
  { variable: '${followUpDateOnly}', sampleLabel: 'Jan 15' },
];

function getVariableChips(primaryUse: 'fundraising' | 'b2b') {
  return primaryUse === 'b2b' ? B2B_CHIPS : FUNDRAISING_CHIPS;
}

interface MessageTemplateModalProps {
  isOpen: boolean;
  isCreating: boolean;
  editingTemplate: MessageTemplate | null;
  defaultChannel: TemplateChannel;
  channelOptions: TemplateChannel[];
  primaryUse?: 'fundraising' | 'b2b';
  onClose: () => void;
  onCreate: (data: { title: string; channel: TemplateChannel; template: string }) => Promise<void>;
  onUpdate: (id: string, data: { title: string; channel: TemplateChannel; template: string }) => Promise<void>;
}

const MessageTemplateModal: React.FC<MessageTemplateModalProps> = ({
  isOpen,
  isCreating,
  editingTemplate,
  defaultChannel,
  channelOptions,
  primaryUse = 'fundraising',
  onClose,
  onCreate,
  onUpdate,
}) => {
  const [formData, setFormData] = useState<{
    title: string;
    channel: TemplateChannel;
    template: string;
  }>({
    title: '',
    channel: 'direct',
    template: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
        setFormData({
          title: (editingTemplate.title || '').trim(),
          channel,
          template: (editingTemplate.template || '').trim(),
        });
      } else {
        setFormData({
          title: '',
          channel: channelOptions.includes(defaultChannel) ? defaultChannel : channelOptions[0],
          template: '',
        });
      }
    }
  }, [isOpen, editingTemplate, defaultChannel, channelOptions]);

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
              Title
            </label>
            <input
              type="text"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              placeholder="e.g., Sequence 1"
              disabled={isSubmitting}
            />
          </div>

          <div>
            <label className="flex items-center justify-between gap-2 text-sm font-medium text-gray-700 mb-2">
              <span>Template</span>
              <span className="text-gray-400 font-normal text-xs shrink-0">
                {formData.template.trim()
                  ? (() => {
                      const text = formData.template.trim();
                      const words = text.split(/\s+/).filter(Boolean).length;
                      const chars = text.length;
                      const sec = Math.ceil(words / 2.5);
                      return `${words} word${words !== 1 ? 's' : ''} · ${chars} char${chars !== 1 ? 's' : ''} · ~${sec < 60 ? `${sec}s` : `${Math.ceil(sec / 60)}m`} reading time`;
                    })()
                  : '—'}
              </span>
            </label>
            <textarea
              ref={textareaRef}
              value={formData.template}
              onChange={(e) => setFormData({ ...formData, template: e.target.value })}
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
