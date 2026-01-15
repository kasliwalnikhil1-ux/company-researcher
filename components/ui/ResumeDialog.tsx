"use client";

import React from 'react';

interface ResumeDialogProps {
  isOpen: boolean;
  onResume: () => void;
  onStartFresh: () => void;
  onClose: () => void;
  progressInfo?: {
    current: number;
    total: number;
    lastSavedAt: number;
  };
}

const ResumeDialog: React.FC<ResumeDialogProps> = ({
  isOpen,
  onResume,
  onStartFresh,
  onClose,
  progressInfo,
}) => {
  if (!isOpen) return null;

  const formatTimeAgo = (timestamp: number): string => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds} seconds ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    return `${days} days ago`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <div className="flex items-center justify-center mb-4">
          <div className="flex-shrink-0 w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
            <svg
              className="w-6 h-6 text-blue-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
        </div>
        
        <h2 className="text-2xl font-semibold text-center mb-2">Resume Processing?</h2>
        
        {progressInfo && (
          <div className="mb-4 p-3 bg-blue-50 rounded-sm">
            <p className="text-sm text-gray-700 mb-2">
              <span className="font-medium">Progress:</span> {progressInfo.current} / {progressInfo.total} domains processed
            </p>
            <p className="text-xs text-gray-600">
              Last saved: {formatTimeAgo(progressInfo.lastSavedAt)}
            </p>
            <div className="w-full bg-blue-200 rounded-full h-2 mt-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all"
                style={{ width: `${(progressInfo.current / progressInfo.total) * 100}%` }}
              ></div>
            </div>
          </div>
        )}
        
        <p className="text-gray-600 text-center mb-6">
          You have saved progress from a previous session. Would you like to resume from where you left off, or start fresh?
        </p>
        
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => {
              onResume();
              onClose();
            }}
            className="px-6 py-2 bg-blue-600 text-white rounded-sm hover:bg-blue-700 transition-colors"
          >
            Resume
          </button>
          <button
            onClick={() => {
              onStartFresh();
              onClose();
            }}
            className="px-6 py-2 bg-gray-200 text-gray-700 rounded-sm hover:bg-gray-300 transition-colors"
          >
            Start Fresh
          </button>
          <button
            onClick={onClose}
            className="px-6 py-2 bg-gray-100 text-gray-600 rounded-sm hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default ResumeDialog;

