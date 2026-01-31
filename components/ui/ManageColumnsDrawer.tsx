"use client";

import React, { useState } from "react";
import { X, GripVertical } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// Sortable Column Item Component
interface SortableColumnItemProps {
  column: string;
  columnLabel: string;
  isVisible: boolean;
  onToggle: () => void;
}

function SortableColumnItem({ column, columnLabel, isVisible, onToggle }: SortableColumnItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: column });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center justify-between p-2 hover:bg-gray-50 rounded"
    >
      <div className="flex items-center gap-2 flex-1">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing touch-none"
          aria-label="Drag to reorder"
        >
          <GripVertical className="w-4 h-4 text-gray-400" />
        </button>
        <label className="flex items-center cursor-pointer flex-1">
          <input
            type="checkbox"
            checked={isVisible}
            onChange={onToggle}
            className="mr-2 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            onClick={(e) => e.stopPropagation()}
          />
          <span className="text-sm text-gray-700">{columnLabel}</span>
        </label>
      </div>
    </div>
  );
}

interface ManageColumnsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  columnOrder: string[];
  visibleColumns: Set<string>;
  columnLabels: Record<string, string>;
  clipboardColumn: string | null;
  subjectColumn: string | null;
  phoneClickBehavior: 'whatsapp' | 'call';
  onColumnOrderChange: (newOrder: string[]) => void;
  onToggleColumn: (column: string) => void;
  onClipboardColumnChange: (column: string | null) => void;
  onSubjectColumnChange: (column: string | null) => void;
  onPhoneClickBehaviorChange: (behavior: 'whatsapp' | 'call') => void;
  onSave?: () => Promise<void>;
}

const ManageColumnsDrawer: React.FC<ManageColumnsDrawerProps> = ({
  isOpen,
  onClose,
  columnOrder,
  visibleColumns,
  columnLabels,
  clipboardColumn,
  subjectColumn,
  phoneClickBehavior,
  onColumnOrderChange,
  onToggleColumn,
  onClipboardColumnChange,
  onSubjectColumnChange,
  onPhoneClickBehaviorChange,
  onSave,
}) => {
  const [activeTab, setActiveTab] = useState<"settings" | "columns">("settings");
  const [saving, setSaving] = useState(false);

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Handle drag end
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = columnOrder.indexOf(active.id as string);
      const newIndex = columnOrder.indexOf(over.id as string);
      const newOrder = arrayMove(columnOrder, oldIndex, newIndex);
      onColumnOrderChange(newOrder);
    }
  };

  if (!isOpen) return null;

  const formatColumnLabel = (column: string): string => {
    return columnLabels[column] || column.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/30 backdrop-blur-sm z-40 transition-opacity duration-300 ${
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className={`fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-xl z-50 transform transition-transform duration-300 ease-in-out ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">Manage Columns</h3>
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
              aria-label="Close drawer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-200">
            <button
              onClick={() => setActiveTab("settings")}
              className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === "settings"
                  ? "text-indigo-600 border-b-2 border-indigo-600"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Settings
            </button>
            <button
              onClick={() => setActiveTab("columns")}
              className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === "columns"
                  ? "text-indigo-600 border-b-2 border-indigo-600"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Column Visibility & Order
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === "settings" ? (
              <div className="space-y-6">
                {/* Clipboard Column Selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Clipboard Column
                  </label>
                  <p className="text-xs text-gray-500 mb-3">
                    Copied when opening Domain/Instagram links
                  </p>
                  <select
                    value={clipboardColumn || ''}
                    onChange={(e) => onClipboardColumnChange(e.target.value || null)}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    <option value="">None</option>
                    {columnOrder.map((column) => (
                      <option key={column} value={column}>
                        {formatColumnLabel(column)}
                      </option>
                    ))}
                  </select>
                  {clipboardColumn && (
                    <p className="mt-2 text-xs text-gray-500">
                      Selected: {formatColumnLabel(clipboardColumn)}
                    </p>
                  )}
                </div>

                {/* Subject Column Selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Subject Column
                  </label>
                  <p className="text-xs text-gray-500 mb-3">
                    Used as email subject when opening email links
                  </p>
                  <select
                    value={subjectColumn || ''}
                    onChange={(e) => onSubjectColumnChange(e.target.value || null)}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    <option value="">None</option>
                    {columnOrder.map((column) => (
                      <option key={column} value={column}>
                        {formatColumnLabel(column)}
                      </option>
                    ))}
                  </select>
                  {subjectColumn && (
                    <p className="mt-2 text-xs text-gray-500">
                      Selected: {formatColumnLabel(subjectColumn)}
                    </p>
                  )}
                </div>

                {/* Phone Click Behavior Selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Phone Click Behavior
                  </label>
                  <select
                    value={phoneClickBehavior}
                    onChange={(e) => onPhoneClickBehaviorChange(e.target.value as 'whatsapp' | 'call')}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    <option value="whatsapp">WhatsApp (opens WhatsApp and copies Clipboard Column)</option>
                    <option value="call">Call (uses tel: link)</option>
                  </select>
                  <p className="mt-2 text-xs text-gray-500">
                    Selected: {phoneClickBehavior === 'whatsapp' ? 'WhatsApp' : 'Call'}
                  </p>
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">
                  Column Visibility & Order
                </label>
                <p className="text-xs text-gray-500 mb-4">
                  Drag to reorder, check/uncheck to show/hide columns
                </p>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={columnOrder}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-2">
                      {columnOrder.map((column) => (
                        <SortableColumnItem
                          key={column}
                          column={column}
                          columnLabel={formatColumnLabel(column)}
                          isVisible={visibleColumns.has(column)}
                          onToggle={() => onToggleColumn(column)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-6 border-t border-gray-200 flex gap-3">
            {onSave && (
              <button
                onClick={async () => {
                  try {
                    setSaving(true);
                    await onSave();
                  } catch (e) {
                    console.error('Failed to save column settings', e);
                  } finally {
                    setSaving(false);
                  }
                }}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
            <button
              onClick={onClose}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${onSave ? 'border border-gray-300 text-gray-700 hover:bg-gray-50' : 'w-full bg-indigo-600 text-white hover:bg-indigo-700'}`}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default ManageColumnsDrawer;
