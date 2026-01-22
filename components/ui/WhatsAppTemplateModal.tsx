"use client";

import React, { useMemo } from 'react';
import { X } from 'lucide-react';

interface WhatsAppTemplateModalProps {
  isOpen: boolean;
  templateColumns: string[];
  columnLabels: Record<string, string>;
  onSelectTemplate: (columnKey: string) => void;
  onClose: () => void;
}

const WhatsAppTemplateModal: React.FC<WhatsAppTemplateModalProps> = ({
  isOpen,
  templateColumns,
  columnLabels,
  onSelectTemplate,
  onClose,
}) => {
  // Sort columns: prioritize those with "Whatsapp" in the title
  const sortedColumns = useMemo(() => {
    const whatsappColumns: string[] = [];
    const otherColumns: string[] = [];

    templateColumns.forEach(column => {
      const label = columnLabels[column] || column;
      const lowerLabel = label.toLowerCase();
      
      if (lowerLabel.includes('whatsapp') || lowerLabel.includes('whats app')) {
        whatsappColumns.push(column);
      } else {
        otherColumns.push(column);
      }
    });

    return [...whatsappColumns, ...otherColumns];
  }, [templateColumns, columnLabels]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-semibold">Select Message Template</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <p className="text-gray-600 mb-4">
          Choose a message template to use for WhatsApp. Templates with "Whatsapp" in the title are shown first.
        </p>
        
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {sortedColumns.length > 0 ? (
            sortedColumns.map((column) => {
              const label = columnLabels[column] || column.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
              const isWhatsapp = label.toLowerCase().includes('whatsapp') || label.toLowerCase().includes('whats app');
              
              return (
                <button
                  key={column}
                  onClick={() => {
                    onSelectTemplate(column);
                    onClose();
                  }}
                  className={`w-full text-left px-4 py-3 rounded-sm border-2 transition-colors ${
                    isWhatsapp
                      ? 'border-green-200 bg-green-50 hover:border-green-300 hover:bg-green-100'
                      : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <div className="font-medium text-sm">{label}</div>
                  {isWhatsapp && (
                    <div className="text-xs text-green-600 mt-1">WhatsApp Template</div>
                  )}
                </button>
              );
            })
          ) : (
            <div className="text-center py-8 text-gray-500">
              <p>No message template columns found</p>
            </div>
          )}
        </div>
        
        <div className="flex gap-3 justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 border border-gray-300 rounded-sm hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default WhatsAppTemplateModal;
