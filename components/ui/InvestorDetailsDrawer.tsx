'use client';

import React, { useState, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { X, ChevronLeft, ChevronRight, MapPin, Briefcase, Target, Globe, ExternalLink, CheckCircle, XCircle, Minus, Sparkles, Loader2, Mail, Phone, Link2, User, FileText, Copy, Check, Linkedin, Twitter, Plus, Edit2, Trash2 } from 'lucide-react';
import { fetchInvestorDeepResearch } from '@/lib/api';
import { formatHqLocation } from '@/lib/isoCodes';
import { copyToClipboard } from '@/lib/utils';

const getDomainFromUrl = (urlStr: string): string | null => {
  try {
    const url = new URL(urlStr);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

function CompanyLogo({ name, url }: { name: string; url?: string }) {
  const domain = url ? getDomainFromUrl(url) : null;
  const [clearbitFailed, setClearbitFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);

  const showLetter = !domain || (clearbitFailed && faviconFailed);
  const showFavicon = domain && clearbitFailed && !faviconFailed;
  const showClearbit = domain && !clearbitFailed;

  return (
    <div className="w-5 h-5 rounded-full overflow-hidden flex items-center justify-center flex-shrink-0 bg-gray-100">
      {showLetter ? (
        <span className="text-xs font-semibold text-gray-600">{name.charAt(0).toUpperCase()}</span>
      ) : showFavicon ? (
        <img
          src={`https://www.google.com/s2/favicons?sz=256&domain=${domain}`}
          alt=""
          onError={() => setFaviconFailed(true)}
          className="w-full h-full object-contain"
        />
      ) : (
        <img
          src={`https://logo.clearbit.com/${domain}`}
          alt=""
          onError={() => setClearbitFailed(true)}
          className="w-full h-full object-contain"
        />
      )}
    </div>
  );
}

export interface InvestorDetails {
  id: string;
  name: string;
  type?: string | null;
  active?: boolean | null;
  role?: string | null;
  hq_state?: string | null;
  hq_country?: string | null;
  investor_type?: string[] | null;
  fund_size_usd?: number | null;
  check_size_min_usd?: number | null;
  check_size_max_usd?: number | null;
  investment_stages?: string[] | null;
  investment_industries?: string[] | null;
  investment_geographies?: string[] | null;
  investment_thesis?: string | null;
  notable_investments?: string[] | string | null;
  leads_round?: boolean | null;
  has_personalization?: boolean;
  /** Personalization fields - only present when has_personalization === true */
  set_name?: string | null;
  owner?: string | null;
  /** jsonb - array of note objects: [{ message: string, date: string }] */
  notes?: Array<{ message: string; date: string }> | null;
  stage?: string | null;
  ai_metadata?: Record<string, unknown> | null;
  domain?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  /** Comma-separated list of emails */
  email?: string | null;
  /** Comma-separated list of phone numbers */
  phone?: string | null;
  /** Array of "[text](url)" formatted links */
  links?: string[] | null;
}

interface InvestorDetailsDrawerProps {
  isOpen: boolean;
  investor: InvestorDetails | null;
  onClose: () => void;
  investors: InvestorDetails[];
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onInvestorChange?: (investor: InvestorDetails) => void;
  onAnalyze?: (investorId: string) => void;
  isAnalyzing?: boolean;
  updateInvestor?: (
    investorId: string,
    updates: Partial<Pick<InvestorDetails, 'notes' | 'owner' | 'set_name' | 'stage' | 'ai_metadata'>>
  ) => Promise<void>;
  stageOptions?: string[];
  setOptions?: string[];
  ownerOptions?: string[];
}

const formatCurrency = (value: number | null | undefined): string => {
  if (value == null || value === 0) return '-';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value}`;
};

const formatKebabLabel = (value: string): string =>
  value
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

const parseNotableInvestment = (s: string): { name: string; url: string } | null => {
  const match = s.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  return match ? { name: match[1], url: match[2] } : null;
};

/** Parse comma-separated text into trimmed non-empty list */
const parseCommaList = (text: string | null | undefined): string[] => {
  if (!text || typeof text !== 'string') return [];
  return text.split(',').map((s) => s.trim()).filter(Boolean);
};

function DetailRow({
  label,
  icon,
  value,
}: {
  label: string;
  icon: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 flex-shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
        <div className="text-sm text-gray-900 mt-0.5">{value}</div>
      </div>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-sm font-medium text-gray-900">{value}</p>
    </div>
  );
}

function DetailSection({
  label,
  icon,
  value,
}: {
  label: string;
  icon?: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
        {icon}
        {label}
      </h3>
      <div className="text-sm text-gray-700">{value}</div>
    </div>
  );
}

const InvestorDetailsDrawer: React.FC<InvestorDetailsDrawerProps> = ({
  isOpen,
  investor,
  onClose,
  investors,
  currentPage,
  totalPages,
  onPageChange,
  onInvestorChange,
  onAnalyze,
  isAnalyzing,
  updateInvestor,
  stageOptions = [],
  setOptions = [],
  ownerOptions = [],
}) => {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'profile' | 'pipeline' | 'deep-research'>('profile');
  const [notes, setNotes] = useState<Array<{ message: string; date: string }>>([]);
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [editingNoteIndex, setEditingNoteIndex] = useState<number | null>(null);
  const [newNoteMessage, setNewNoteMessage] = useState('');
  const [noteToDelete, setNoteToDelete] = useState<number | null>(null);
  const [noteToast, setNoteToast] = useState<string | null>(null);
  const [pipelineSaving, setPipelineSaving] = useState(false);
  const [deepResearchContent, setDeepResearchContent] = useState<string | null>(null);
  const [deepResearchLoading, setDeepResearchLoading] = useState(false);
  const [deepResearchError, setDeepResearchError] = useState<string | null>(null);
  const [editingAiMetadata, setEditingAiMetadata] = useState(false);
  const [aiMetadataLine1, setAiMetadataLine1] = useState('');
  const [aiMetadataLine2, setAiMetadataLine2] = useState('');
  const [aiMetadataMutualInterestsText, setAiMetadataMutualInterestsText] = useState('');
  const [aiMetadataSaving, setAiMetadataSaving] = useState(false);

  // Reset tab when investor changes
  useEffect(() => {
    setActiveTab('profile');
    setDeepResearchContent(null);
    setDeepResearchError(null);
  }, [investor?.id]);

  // Load notes from investor when investor changes
  useEffect(() => {
    if (investor?.notes && Array.isArray(investor.notes)) {
      setNotes(investor.notes);
    } else {
      setNotes([]);
    }
    setIsAddingNote(false);
    setEditingNoteIndex(null);
    setNewNoteMessage('');
    setNoteToDelete(null);
  }, [investor?.id, investor?.notes]);

  // Load ai_metadata Personalization and mutual_interests when investor changes
  useEffect(() => {
    const meta = investor?.ai_metadata;
    if (meta && typeof meta === 'object') {
      setAiMetadataLine1(typeof meta.line1 === 'string' ? meta.line1 : '');
      setAiMetadataLine2(typeof meta.line2 === 'string' ? meta.line2 : '');
      const interests = Array.isArray(meta.mutual_interests)
        ? (meta.mutual_interests as string[]).filter((s): s is string => typeof s === 'string')
        : [];
      setAiMetadataMutualInterestsText(interests.join('\n'));
    } else {
      setAiMetadataLine1('');
      setAiMetadataLine2('');
      setAiMetadataMutualInterestsText('');
    }
    setEditingAiMetadata(false);
  }, [investor?.id, investor?.ai_metadata]);

  const DEEP_RESEARCH_STORAGE_KEY = (id: string) => `investor-deep-research-${id}`;

  const loadDeepResearch = useCallback(async (investorId: string) => {
    if (typeof window === 'undefined') return;
    const cached = localStorage.getItem(DEEP_RESEARCH_STORAGE_KEY(investorId));
    if (cached !== null) {
      setDeepResearchContent(cached);
      return;
    }
    setDeepResearchLoading(true);
    setDeepResearchError(null);
    const result = await fetchInvestorDeepResearch(investorId);
    setDeepResearchLoading(false);
    if (result?.error) {
      setDeepResearchError(result.error);
      setDeepResearchContent(null);
    } else if (result?.deep_research != null) {
      const content = result.deep_research || '';
      setDeepResearchContent(content);
      localStorage.setItem(DEEP_RESEARCH_STORAGE_KEY(investorId), content);
    } else {
      setDeepResearchContent(null);
    }
  }, []);

  useEffect(() => {
    if (investor && activeTab === 'deep-research') {
      loadDeepResearch(investor.id);
    }
  }, [investor?.id, activeTab, loadDeepResearch]);

  const handleAddNote = useCallback(() => {
    setIsAddingNote(true);
    setNewNoteMessage('');
  }, []);

  const handleCancelAddNote = useCallback(() => {
    setIsAddingNote(false);
    setNewNoteMessage('');
  }, []);

  const handleSaveNote = useCallback(async () => {
    if (!investor || !newNoteMessage.trim() || !updateInvestor) return;

    try {
      const updatedNotes = [...notes];

      if (editingNoteIndex !== null) {
        const originalNote = notes[editingNoteIndex];
        updatedNotes[editingNoteIndex] = {
          message: newNoteMessage.trim(),
          date: originalNote.date,
        };
      } else {
        const today = new Date().toISOString().split('T')[0];
        updatedNotes.push({ message: newNoteMessage.trim(), date: today });
      }

      updatedNotes.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      await updateInvestor(investor.id, { notes: updatedNotes });
      setNotes(updatedNotes);
      if (onInvestorChange) {
        onInvestorChange({ ...investor, notes: updatedNotes });
      }

      setIsAddingNote(false);
      setEditingNoteIndex(null);
      setNewNoteMessage('');
      setNoteToast(editingNoteIndex !== null ? 'Note updated successfully' : 'Note added successfully');
      setTimeout(() => setNoteToast(null), 3000);
    } catch (err) {
      console.error('Error saving note:', err);
    }
  }, [investor, notes, newNoteMessage, editingNoteIndex, updateInvestor, onInvestorChange]);

  const handleEditNote = useCallback((index: number) => {
    const note = notes[index];
    if (note) {
      setEditingNoteIndex(index);
      setNewNoteMessage(note.message);
      setIsAddingNote(true);
    }
  }, [notes]);

  const handleCancelEditNote = useCallback(() => {
    setEditingNoteIndex(null);
    setIsAddingNote(false);
    setNewNoteMessage('');
  }, []);

  const handleDeleteNoteClick = useCallback((index: number) => {
    setNoteToDelete(index);
  }, []);

  const handleDeleteNoteConfirm = useCallback(async () => {
    if (!investor || noteToDelete === null || !updateInvestor) return;

    try {
      const updatedNotes = notes.filter((_, index) => index !== noteToDelete);
      const finalNotes = updatedNotes.length > 0 ? updatedNotes : null;
      await updateInvestor(investor.id, { notes: finalNotes });
      setNotes(updatedNotes);
      if (onInvestorChange) {
        onInvestorChange({ ...investor, notes: finalNotes });
      }
      setNoteToDelete(null);
      setNoteToast('Note deleted successfully');
      setTimeout(() => setNoteToast(null), 3000);
    } catch (err) {
      console.error('Error deleting note:', err);
      setNoteToDelete(null);
    }
  }, [investor, notes, noteToDelete, updateInvestor, onInvestorChange]);

  const handleDeleteNoteCancel = useCallback(() => {
    setNoteToDelete(null);
  }, []);

  const handleSaveAiMetadata = useCallback(async () => {
    if (!investor || !updateInvestor) return;

    const meta = investor.ai_metadata && typeof investor.ai_metadata === 'object' ? investor.ai_metadata : {};
    const mutualInterests = aiMetadataMutualInterestsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const updatedAiMetadata: Record<string, unknown> = {
      ...meta,
      line1: aiMetadataLine1.trim() || null,
      line2: aiMetadataLine2.trim() || null,
      mutual_interests: mutualInterests,
    };

    try {
      setAiMetadataSaving(true);
      await updateInvestor(investor.id, { ai_metadata: updatedAiMetadata });
      if (onInvestorChange) {
        onInvestorChange({ ...investor, ai_metadata: updatedAiMetadata });
      }
      setEditingAiMetadata(false);
      setNoteToast('Personalization saved');
      setTimeout(() => setNoteToast(null), 3000);
    } catch (err) {
      console.error('Error saving ai_metadata:', err);
    } finally {
      setAiMetadataSaving(false);
    }
  }, [investor, aiMetadataLine1, aiMetadataLine2, aiMetadataMutualInterestsText, updateInvestor, onInvestorChange]);

  const handleCancelEditAiMetadata = useCallback(() => {
    const meta = investor?.ai_metadata && typeof investor.ai_metadata === 'object' ? investor.ai_metadata : {};
    setAiMetadataLine1(typeof meta.line1 === 'string' ? meta.line1 : '');
    setAiMetadataLine2(typeof meta.line2 === 'string' ? meta.line2 : '');
    const interests = Array.isArray(meta.mutual_interests)
      ? (meta.mutual_interests as string[]).filter((s): s is string => typeof s === 'string')
      : [];
    setAiMetadataMutualInterestsText(interests.join('\n'));
    setEditingAiMetadata(false);
  }, [investor?.ai_metadata]);

  const handlePipelineFieldChange = useCallback(
    async (field: 'owner' | 'set_name' | 'stage', value: string | null) => {
      if (!investor || !updateInvestor) return;
      const trimmed = typeof value === 'string' ? value.trim() || null : null;
      try {
        setPipelineSaving(true);
        await updateInvestor(investor.id, { [field]: trimmed });
        if (onInvestorChange) {
          onInvestorChange({ ...investor, [field]: trimmed });
        }
      } catch (err) {
        console.error('Error updating pipeline field:', err);
      } finally {
        setPipelineSaving(false);
      }
    },
    [investor, updateInvestor, onInvestorChange]
  );

  const handleCopyField = async (text: string, field: string) => {
    try {
      await copyToClipboard(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const currentIndex = investor ? investors.findIndex((i) => i.id === investor.id) : -1;
  const hasPrev = currentIndex > 0 || (currentIndex === 0 && currentPage > 1);
  const hasNext = currentIndex >= 0 && (currentIndex < investors.length - 1 || currentPage < totalPages);

  const handlePrev = () => {
    if (currentIndex > 0 && onInvestorChange) {
      onInvestorChange(investors[currentIndex - 1]);
    } else if (currentPage > 1) {
      onPageChange(currentPage - 1);
    }
  };

  const handleNext = () => {
    if (currentIndex >= 0 && currentIndex < investors.length - 1 && onInvestorChange) {
      onInvestorChange(investors[currentIndex + 1]);
    } else if (currentPage < totalPages) {
      onPageChange(currentPage);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 transition-opacity duration-300"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`fixed right-0 top-0 h-full w-full max-w-2xl bg-white shadow-xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrev}
              disabled={!hasPrev}
              className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Previous investor"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={handleNext}
              disabled={!hasNext}
              className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Next investor"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs - only when has_personalization */}
        {investor?.has_personalization && (
          <div className="flex gap-1 px-4 pt-2 border-b border-gray-200 flex-shrink-0">
            <button
              onClick={() => setActiveTab('profile')}
              className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === 'profile'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Investor Profile
            </button>
            <button
              onClick={() => setActiveTab('pipeline')}
              className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === 'pipeline'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Pipeline
            </button>
            <button
              onClick={() => setActiveTab('deep-research')}
              className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === 'deep-research'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Deep Research
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {!investor ? (
            <p className="text-gray-500 text-sm">Select an investor to view details.</p>
          ) : investor.has_personalization && activeTab === 'pipeline' ? (
            /* Pipeline tab content */
            <div className="space-y-6">
              <div className="space-y-4">
                {/* Owner, Set, Stage - always shown, editable */}
                {updateInvestor && (
                  <div className="space-y-4">
                    <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Pipeline</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Stage</label>
                        <select
                          value={investor.stage?.trim() ?? 'Identified'}
                          onChange={(e) => handlePipelineFieldChange('stage', e.target.value || null)}
                          disabled={pipelineSaving}
                          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
                        >
                          {stageOptions.map((s: string) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Owner</label>
                        <select
                          value={investor.owner?.trim() ?? ''}
                          onChange={(e) => handlePipelineFieldChange('owner', e.target.value || null)}
                          disabled={pipelineSaving}
                          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
                        >
                          <option value="">— Select —</option>
                          {ownerOptions.map((o: string) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Set</label>
                        <select
                          value={investor.set_name?.trim() ?? ''}
                          onChange={(e) => handlePipelineFieldChange('set_name', e.target.value || null)}
                          disabled={pipelineSaving}
                          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
                        >
                          <option value="">— Select —</option>
                          {setOptions.map((s: string) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {pipelineSaving && (
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Saving...
                      </div>
                    )}
                    <hr className="border-gray-200" />
                  </div>
                )}

                {(investor.domain?.trim() ||
                    investor.linkedin_url?.trim() ||
                    investor.twitter_url?.trim() ||
                    parseCommaList(investor.email).length > 0 ||
                    parseCommaList(investor.phone).length > 0) && (
                    <div>
                      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Contact Details</h3>
                      <div className="flex flex-wrap items-center gap-4">
                      <div className="flex items-center gap-1">
                        {investor.domain?.trim() && (
                          <a
                            href={
                              /^https?:\/\//i.test(investor.domain!)
                                ? investor.domain!
                                : `https://${investor.domain!.replace(/^www\./, '')}`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-2 rounded-lg text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                            title={investor.domain!.replace(/^https?:\/\//i, '').replace(/^www\./, '')}
                            aria-label="Visit website"
                          >
                            <Globe className="w-5 h-5" />
                          </a>
                        )}
                        {investor.linkedin_url?.trim() && (
                          <a
                            href={investor.linkedin_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-2 rounded-lg text-gray-500 hover:text-[#0A66C2] hover:bg-[#0A66C2]/10 transition-colors"
                            title="LinkedIn"
                            aria-label="Open LinkedIn"
                          >
                            <Linkedin className="w-5 h-5" />
                          </a>
                        )}
                        {investor.twitter_url?.trim() && (
                          <a
                            href={investor.twitter_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-2 rounded-lg text-gray-500 hover:text-[#1DA1F2] hover:bg-[#1DA1F2]/10 transition-colors"
                            title="Twitter"
                            aria-label="Open Twitter"
                          >
                            <Twitter className="w-5 h-5" />
                          </a>
                        )}
                      </div>
                      {(() => {
                        const emails = parseCommaList(investor.email);
                        return emails.length > 0 ? (
                          <div className="flex items-center gap-2">
                            <Mail className="w-4 h-4 text-gray-400 flex-shrink-0" />
                            <div className="flex flex-wrap gap-x-3 gap-y-0">
                              {emails.map((e, idx) => (
                                <a
                                  key={idx}
                                  href={`mailto:${e}`}
                                  className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                                >
                                  {e}
                                </a>
                              ))}
                            </div>
                          </div>
                        ) : null;
                      })()}
                      {(() => {
                        const phones = parseCommaList(investor.phone);
                        return phones.length > 0 ? (
                          <div className="flex items-center gap-2">
                            <Phone className="w-4 h-4 text-gray-400 flex-shrink-0" />
                            <div className="flex flex-wrap gap-x-3 gap-y-0">
                              {phones.map((p, idx) => (
                                <a
                                  key={idx}
                                  href={`tel:${p.replace(/\s/g, '')}`}
                                  className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                                >
                                  {p}
                                </a>
                              ))}
                            </div>
                          </div>
                        ) : null;
                      })()}
                    </div>
                    </div>
                  )}
                  {investor.has_personalization && updateInvestor && (
                    <div>
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1">
                          <FileText className="w-3.5 h-3.5 text-gray-400" />
                          Notes
                        </h3>
                        {!isAddingNote && (
                          <button
                            type="button"
                            onClick={handleAddNote}
                            className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-indigo-600 bg-indigo-50 rounded-md hover:bg-indigo-100 transition-colors"
                          >
                            <Plus className="w-4 h-4 mr-1" />
                            Add Note
                          </button>
                        )}
                      </div>

                      {isAddingNote ? (
                        <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50/30 mb-4">
                          <div className="space-y-3">
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">Message</label>
                              <div className="flex flex-wrap gap-2 mb-2">
                                <button
                                  type="button"
                                  onClick={() => setNewNoteMessage('Not Picked')}
                                  className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                                >
                                  Not Picked
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setNewNoteMessage('Interested')}
                                  className="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-300 rounded-md hover:bg-green-100 transition-colors"
                                >
                                  Interested
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setNewNoteMessage('Not Interested')}
                                  className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-300 rounded-md hover:bg-red-100 transition-colors"
                                >
                                  Not Interested
                                </button>
                              </div>
                              <textarea
                                value={newNoteMessage}
                                onChange={(e) => setNewNoteMessage(e.target.value)}
                                placeholder="Enter note message..."
                                rows={3}
                                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                              />
                              {editingNoteIndex === null && (
                                <p className="mt-1 text-xs text-gray-500">Date will be automatically set to today</p>
                              )}
                            </div>
                            <div className="flex gap-2 justify-end">
                              <button
                                type="button"
                                onClick={editingNoteIndex !== null ? handleCancelEditNote : handleCancelAddNote}
                                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={handleSaveNote}
                                disabled={!newNoteMessage.trim()}
                                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {editingNoteIndex !== null ? 'Update' : 'Save'}
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {notes.length > 0 ? (
                        <div className="space-y-3">
                          {notes.map((note, index) => (
                            <div
                              key={index}
                              className="border border-gray-200 rounded-lg p-4 bg-white hover:shadow-md transition-shadow"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="text-xs font-medium text-gray-500">
                                      {new Date(note.date).toLocaleDateString('en-US', {
                                        year: 'numeric',
                                        month: 'short',
                                        day: 'numeric',
                                      })}
                                    </span>
                                  </div>
                                  <p className="text-sm text-gray-900 whitespace-pre-wrap">{note.message}</p>
                                </div>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleEditNote(index)}
                                    className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                                    title="Edit note"
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteNoteClick(index)}
                                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                    title="Delete note"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        !isAddingNote && (
                          <div className="text-center py-8 border border-gray-200 rounded-lg bg-gray-50">
                            <p className="text-sm text-gray-600">No notes yet. Click &quot;Add Note&quot; to create one.</p>
                          </div>
                        )
                      )}
                    </div>
                  )}
                  {investor.has_personalization && updateInvestor && <hr className="border-gray-200" />}
                  {Array.isArray(investor.links) && investor.links.length > 0 && (
                    <DetailSection
                      label="Investor Links"
                      icon={<Link2 className="w-3.5 h-3.5 text-gray-400" />}
                      value={
                        <ul className="list-disc list-inside space-y-2">
                          {investor.links.map((item, idx) => {
                            const parsed = parseNotableInvestment(item);
                            return (
                              <li key={idx}>
                                {parsed ? (
                                  <a
                                    href={parsed.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                                  >
                                    {parsed.name}
                                  </a>
                                ) : (
                                  <span className="text-sm text-gray-700">{item}</span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      }
                    />
                  )}
                </div>
            </div>
          ) : investor.has_personalization && activeTab === 'deep-research' ? (
            /* Deep Research tab content */
            <div className="space-y-4">
              {deepResearchLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                </div>
              ) : deepResearchError ? (
                <p className="text-red-600 text-sm">{deepResearchError}</p>
              ) : deepResearchContent ? (
                <div className="prose prose-base max-w-none [&>*:first-child]:mt-0
                  prose-headings:text-gray-900 prose-headings:font-semibold
                  prose-h1:mt-0 prose-h1:mb-6 prose-h1:text-2xl
                  prose-h2:mt-10 prose-h2:mb-4 prose-h2:text-xl prose-h2:border-b prose-h2:border-gray-200 prose-h2:pb-2
                  prose-h3:mt-8 prose-h3:mb-3 prose-h3:text-lg
                  prose-p:text-gray-700 prose-p:my-4 prose-p:leading-relaxed
                  prose-strong:text-gray-900 prose-strong:font-semibold
                  prose-hr:my-8 prose-hr:border-gray-300
                  prose-ul:my-4 prose-ol:my-4 prose-li:my-2
                  prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline">
                  <ReactMarkdown>{deepResearchContent}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-gray-500 text-sm">No deep research data available for this investor.</p>
              )}
            </div>
          ) : (
            /* Investor Profile tab (default) - current content without Pipeline fields */
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">{investor.name}</h2>
                <div className="flex flex-wrap gap-3 mt-2 text-sm text-gray-600 items-center">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-medium text-gray-500">Active</span>
                    {investor.active === true ? (
                      <CheckCircle className="w-4 h-4 text-emerald-500" />
                    ) : investor.active === false ? (
                      <XCircle className="w-4 h-4 text-gray-400" />
                    ) : (
                      <Minus className="w-4 h-4 text-gray-400" />
                    )}
                    <span>{investor.active === true ? 'Yes' : investor.active === false ? 'No' : '-'}</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-medium text-gray-500">Leads round</span>
                    {investor.leads_round === true ? (
                      <CheckCircle className="w-4 h-4 text-emerald-500" />
                    ) : investor.leads_round === false ? (
                      <XCircle className="w-4 h-4 text-gray-400" />
                    ) : (
                      <Minus className="w-4 h-4 text-gray-400" />
                    )}
                    <span>{investor.leads_round === true ? 'Yes' : investor.leads_round === false ? 'No' : '-'}</span>
                  </span>
                  {investor.has_personalization && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800">
                      <CheckCircle className="w-3 h-3" />
                      Reviewed
                    </span>
                  )}
                </div>
                {!investor.has_personalization && onAnalyze && (
                  <button
                    onClick={() => onAnalyze(investor.id)}
                    disabled={isAnalyzing}
                    className="mt-3 inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                  >
                    {isAnalyzing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Sparkles className="w-4 h-4" />
                    )}
                    Analyze with AI
                  </button>
                )}
              </div>

              {investor.type === 'firm' && investor.role && (
                <DetailRow
                  label="Role"
                  icon={<Briefcase className="w-4 h-4 text-gray-400" />}
                  value={investor.role}
                />
              )}

              {investor.ai_metadata && typeof investor.ai_metadata === 'object' && Object.keys(investor.ai_metadata).length > 0 && (
                <>
                  <hr className="border-gray-200" />
                  <div className="space-y-4">
                    {/* investor_fit */}
                    {typeof investor.ai_metadata.investor_fit === 'boolean' || investor.ai_metadata.investor_fit === null ? (
                      <div className="flex items-center gap-2">
                        <span className="text-lg" role="img" aria-label="fit">
                          {investor.ai_metadata.investor_fit === true ? '😊' : investor.ai_metadata.investor_fit === false ? '😕' : '😐'}
                        </span>
                        <span className="text-sm font-medium text-gray-900">
                          {investor.ai_metadata.investor_fit === true ? 'Strong Fit' : investor.ai_metadata.investor_fit === false ? 'Weak Fit' : 'Unclear Fit'}
                        </span>
                      </div>
                    ) : null}

                    {/* reason */}
                    {typeof investor.ai_metadata.reason === 'string' && investor.ai_metadata.reason.trim() && (
                      <div className="p-3 rounded-lg bg-indigo-50 border border-indigo-100">
                        <p className="text-sm text-gray-800 whitespace-pre-wrap">{investor.ai_metadata.reason}</p>
                      </div>
                    )}

                    {/* Personalization - line1 & line2 - editable (show when has content, or when editing, or when updateInvestor to allow adding) */}
                    {(typeof investor.ai_metadata.line1 === 'string' && investor.ai_metadata.line1.trim()) ||
                    (typeof investor.ai_metadata.line2 === 'string' && investor.ai_metadata.line2.trim()) ||
                    (Array.isArray(investor.ai_metadata.mutual_interests) && investor.ai_metadata.mutual_interests.length > 0) ||
                    editingAiMetadata ||
                    (updateInvestor && investor.has_personalization) ? (
                      <>
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">How to Reach Out Thoughtfully</h3>
                          {updateInvestor && (
                            editingAiMetadata ? (
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={handleCancelEditAiMetadata}
                                  className="px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-800"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={handleSaveAiMetadata}
                                  disabled={aiMetadataSaving}
                                  className="px-2 py-1 text-xs font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50"
                                >
                                  {aiMetadataSaving ? 'Saving...' : 'Save'}
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setEditingAiMetadata(true)}
                                className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-indigo-600 flex-shrink-0"
                                title="Edit"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                            )
                          )}
                        </div>
                        {editingAiMetadata ? (
                          <div className="space-y-3 border border-indigo-200 rounded-lg p-4 bg-indigo-50/30">
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Line 1</label>
                              <textarea
                                value={aiMetadataLine1}
                                onChange={(e) => setAiMetadataLine1(e.target.value)}
                                rows={2}
                                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                placeholder="Personalization line 1..."
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Line 2</label>
                              <textarea
                                value={aiMetadataLine2}
                                onChange={(e) => setAiMetadataLine2(e.target.value)}
                                rows={2}
                                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                placeholder="Personalization line 2..."
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Mutual Interests (one per line)</label>
                              <textarea
                                value={aiMetadataMutualInterestsText}
                                onChange={(e) => setAiMetadataMutualInterestsText(e.target.value)}
                                rows={4}
                                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                placeholder="One interest per line..."
                              />
                            </div>
                          </div>
                        ) : (
                          <>
                            {typeof investor.ai_metadata.line1 === 'string' && investor.ai_metadata.line1.trim() && (
                              <div className="flex items-start gap-2">
                                <p className="text-sm text-gray-700 flex-1">{investor.ai_metadata.line1}</p>
                                <button
                                  type="button"
                                  onClick={() => handleCopyField(investor.ai_metadata!.line1 as string, 'line1')}
                                  className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 flex-shrink-0"
                                  title="Copy"
                                >
                                  {copiedField === 'line1' ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                                </button>
                              </div>
                            )}
                            {typeof investor.ai_metadata.line2 === 'string' && investor.ai_metadata.line2.trim() && (
                              <div className="flex items-start gap-2">
                                <p className="text-sm text-gray-700 flex-1">{investor.ai_metadata.line2}</p>
                                <button
                                  type="button"
                                  onClick={() => handleCopyField(investor.ai_metadata!.line2 as string, 'line2')}
                                  className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 flex-shrink-0"
                                  title="Copy"
                                >
                                  {copiedField === 'line2' ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                                </button>
                              </div>
                            )}
                            {Array.isArray(investor.ai_metadata.mutual_interests) && investor.ai_metadata.mutual_interests.length > 0 && (
                              <DetailSection
                                label="Mutual Interests"
                                value={
                                  <ul className="list-disc list-inside space-y-1">
                                    {(investor.ai_metadata.mutual_interests as string[]).map((interest, idx) => (
                                      <li key={idx} className="text-sm text-gray-700">{interest}</li>
                                    ))}
                                  </ul>
                                }
                              />
                            )}
                          </>
                        )}
                      </>
                    ) : null}

                    <hr className="border-gray-200" />
                  </div>
                </>
              )}

              {/* hq_state & hq_country - show both with readable names */}
              {(investor.hq_state || investor.hq_country) && (
                <DetailRow
                  label="HQ Location"
                  icon={<MapPin className="w-4 h-4 text-gray-400" />}
                  value={formatHqLocation(investor.hq_state, investor.hq_country)}
                />
              )}

              {/* investor_type */}
              <DetailSection
                label="Investor type"
                value={
                  investor.investor_type && investor.investor_type.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {investor.investor_type.map((t) => (
                        <span
                          key={t}
                          className="inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : (
                    '-'
                  )
                }
              />

              {/* investment_thesis */}
              <DetailSection
                label="Investment thesis"
                value={
                  investor.investment_thesis ? (
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{investor.investment_thesis}</p>
                  ) : (
                    '-'
                  )
                }
              />

              {/* fund_size_usd, check_size_min_usd, check_size_max_usd */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <DetailField label="Fund size" value={formatCurrency(investor.fund_size_usd)} />
                <DetailField label="Check size min" value={formatCurrency(investor.check_size_min_usd)} />
                <DetailField label="Check size max" value={formatCurrency(investor.check_size_max_usd)} />
              </div>

              {/* investment_stages */}
              <DetailSection
                label="Investment stages"
                icon={<Target className="w-3.5 h-3.5 text-gray-400" />}
                value={
                  investor.investment_stages && investor.investment_stages.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {investor.investment_stages.map((s) => (
                        <span
                          key={s}
                          className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800"
                        >
                          {formatKebabLabel(s)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    '-'
                  )
                }
              />

              {/* investment_industries */}
              <DetailSection
                label="Investment industries"
                value={
                  investor.investment_industries && investor.investment_industries.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {investor.investment_industries.map((i) => (
                        <span
                          key={i}
                          className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-800"
                        >
                          {formatKebabLabel(i)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    '-'
                  )
                }
              />

              {/* investment_geographies */}
              <DetailSection
                label="Investment geographies"
                icon={<Globe className="w-3.5 h-3.5 text-gray-400" />}
                value={
                  investor.investment_geographies && investor.investment_geographies.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {investor.investment_geographies.map((g) => (
                        <span
                          key={g}
                          className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-sky-50 text-sky-800"
                        >
                          {g}
                        </span>
                      ))}
                    </div>
                  ) : (
                    '-'
                  )
                }
              />

              {/* notable_investments */}
              {(() => {
                const items = Array.isArray(investor.notable_investments)
                  ? investor.notable_investments
                  : typeof investor.notable_investments === 'string'
                    ? [investor.notable_investments]
                    : [];
                return (
                  <DetailSection
                    label="Notable investments"
                    icon={<ExternalLink className="w-3.5 h-3.5 text-gray-400" />}
                    value={
                      items.length > 0 ? (
                        <ul className="space-y-2">
                          {items.map((item, idx) => {
                            const parsed = parseNotableInvestment(item);
                            const displayName = parsed ? parsed.name : item;
                            const displayUrl = parsed ? parsed.url : undefined;
                            return (
                              <li key={idx} className="flex items-center gap-3">
                                <CompanyLogo name={displayName} url={displayUrl} />
                                {parsed ? (
                                  <a
                                    href={parsed.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                                  >
                                    {parsed.name}
                                  </a>
                                ) : (
                                  <span className="text-sm text-gray-700">{item}</span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        '-'
                      )
                    }
                  />
                );
              })()}

              {/* Pipeline fields moved to Pipeline tab when has_personalization */}
            </div>
          )}
        </div>
      </div>

      {/* Note Toast */}
      {noteToast && (
        <div className="fixed bottom-4 right-4 bg-gray-900 text-white px-4 py-2 rounded-md shadow-lg z-[80] transition-opacity duration-300">
          {noteToast}
        </div>
      )}

      {/* Delete Note Confirmation Modal */}
      {noteToDelete !== null && (
        <>
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] transition-opacity duration-300"
            onClick={handleDeleteNoteCancel}
          />
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div
              className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 transform transition-all"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Delete Note</h3>
              <div className="text-sm text-gray-600 mb-6">
                <p className="mb-3">Are you sure you want to delete this note? This action cannot be undone.</p>
                {notes[noteToDelete] && (
                  <div className="mt-3 p-3 bg-gray-50 rounded border border-gray-200">
                    <p className="text-xs text-gray-500 mb-1">
                      {new Date(notes[noteToDelete].date).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </p>
                    <p className="text-sm text-gray-900">{notes[noteToDelete].message}</p>
                  </div>
                )}
              </div>
              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={handleDeleteNoteCancel}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteNoteConfirm}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
};

export default InvestorDetailsDrawer;
