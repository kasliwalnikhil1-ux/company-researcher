'use client';

import React, { useState } from 'react';
import { X, GripVertical } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

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

interface ManageInvestorColumnsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  columnOrder: string[];
  visibleColumns: Set<string>;
  columnLabels: Record<string, string>;
  onColumnOrderChange: (newOrder: string[]) => void;
  onToggleColumn: (column: string) => void;
  onSave?: () => Promise<void>;
}

const ManageInvestorColumnsDrawer: React.FC<ManageInvestorColumnsDrawerProps> = ({
  isOpen,
  onClose,
  columnOrder,
  visibleColumns,
  columnLabels,
  onColumnOrderChange,
  onToggleColumn,
  onSave,
}) => {
  const [saving, setSaving] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = columnOrder.indexOf(active.id as string);
      const newIndex = columnOrder.indexOf(over.id as string);
      const newOrder = arrayMove(columnOrder, oldIndex, newIndex);
      onColumnOrderChange(newOrder);
    }
  };

  const formatColumnLabel = (column: string): string => {
    return columnLabels[column] || column.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/30 backdrop-blur-sm z-40 transition-opacity duration-300 ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-xl z-50 transform transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
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
          <div className="flex-1 overflow-y-auto p-6">
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

export default ManageInvestorColumnsDrawer;
