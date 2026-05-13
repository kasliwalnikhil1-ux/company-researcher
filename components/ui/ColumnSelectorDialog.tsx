"use client";

import React, { useState, useMemo, useRef, useEffect } from 'react';

interface CsvRow {
  [key: string]: string;
}

export interface SelectedColumnsState {
  domain: string | null;
  instagram: string | null;
  email: string | null;
  name: string | null;
  title: string | null;
  linkedin: string | null;
}

const EMPTY_SELECTED_COLUMNS: SelectedColumnsState = {
  domain: null,
  instagram: null,
  email: null,
  name: null,
  title: null,
  linkedin: null,
};

interface ColumnSelectorDialogProps {
  isOpen: boolean;
  columns: string[];
  rows?: CsvRow[];
  selectedColumn: string | null;
  selectedColumns?: SelectedColumnsState;
  onSelectColumn: (column: string) => void;
  onSelectColumns?: (columns: SelectedColumnsState) => void;
  onConfirm: () => void;
  onClose: () => void;
  mode?: 'domain' | 'instagram' | 'investor' | 'jobs' | 'person';
  allowBoth?: boolean;
  onRenameColumn?: (oldName: string, newName: string) => void;
  onCreateDomainFromEmail?: (emailColumn: string) => void;
}

type ContactColumnKind = 'email' | 'name' | 'title' | 'linkedin';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LINKEDIN_PROFILE_RE = /linkedin\.com\/in\//i;
// Word-boundary title keyword regex. Using \b prevents substring false matches
// inside random tracking params or base64-ish URL fragments.
const TITLE_KEYWORD_RE = /\b(ce[oa]|cto|cfo|coo|cmo|chief|founder|co[\s-]?founder|cofounder|president|vp|vice[\s-]president|director|head of|manager|lead|principal|partner|owner|engineer|designer|analyst|consultant)\b/i;

const looksLikeUrl = (value: string): boolean => {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (trimmed.startsWith('www.')) return true;
  if (trimmed.includes('://')) return true;
  // Path-like or query-string-like — common for pasted URLs without protocol.
  if (/^[\w.-]+\.[a-z]{2,}\//i.test(trimmed)) return true;
  if (trimmed.length > 60 && (trimmed.includes('?') || trimmed.includes('&') || trimmed.includes('#'))) return true;
  return false;
};

const looksLikeEmail = (value: string): boolean => {
  if (!value || typeof value !== 'string') return false;
  return EMAIL_RE.test(value.trim());
};

const looksLikeLinkedInProfile = (value: string): boolean => {
  if (!value || typeof value !== 'string') return false;
  return LINKEDIN_PROFILE_RE.test(value.trim());
};

const looksLikePersonName = (value: string): boolean => {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length > 80) return false;
  if (looksLikeUrl(trimmed) || looksLikeEmail(trimmed)) return false;
  // 1-4 words, mostly letters, no digits/@/slashes; allows hyphens & apostrophes.
  return /^[A-Za-z][A-Za-z .'\-]{1,80}$/.test(trimmed) && trimmed.split(/\s+/).length <= 4;
};

const looksLikeTitle = (value: string): boolean => {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length < 2 || trimmed.length > 120) return false;
  // Reject URLs, emails, and obvious tracking junk.
  if (looksLikeUrl(trimmed) || looksLikeEmail(trimmed)) return false;
  // Lots of digits or special chars => not a real title.
  const nonWord = (trimmed.match(/[^A-Za-z\s.,'\-/&]/g) || []).length;
  if (nonWord > trimmed.length * 0.15) return false;
  return TITLE_KEYWORD_RE.test(trimmed);
};

const ColumnSelectorDialog: React.FC<ColumnSelectorDialogProps> = ({
  isOpen,
  columns,
  rows = [],
  selectedColumn,
  selectedColumns,
  onSelectColumn,
  onSelectColumns,
  onConfirm,
  onClose,
  mode = 'domain',
  allowBoth = false,
  onRenameColumn,
  onCreateDomainFromEmail,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [localSelectedColumns, setLocalSelectedColumns] = useState<SelectedColumnsState>(
    selectedColumns ? { ...EMPTY_SELECTED_COLUMNS, ...selectedColumns } : { ...EMPTY_SELECTED_COLUMNS }
  );
  const [editingColumn, setEditingColumn] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const autoSelectedKeyRef = useRef<string | null>(null);
  // Tracks slots the user has explicitly interacted with (picked or cleared)
  // so auto-detection doesn't overwrite their choice — including an explicit
  // "— None —". Reset when the dialog closes.
  const touchedSlotsRef = useRef<Set<keyof SelectedColumnsState>>(new Set());

  // Excluded domains (social media and platforms)
  const excludedDomains = [
    'linkedin.com',
    'linkedin',
    'twitter.com',
    'twitter',
    'x.com',
    'facebook.com',
    'facebook',
    'instagram.com',
    'instagram',
    'wikipedia.org',
    'wikipedia',
    'apollo.io',
    'apollo',
    'amazonaws.com',
    'amazonaws',
  ];

  // Check if a URL is from an excluded domain
  const isExcludedDomain = (url: string): boolean => {
    if (!url || typeof url !== 'string') return false;
    const urlLower = url.toLowerCase().trim();
    if (!urlLower.includes('.')) return false;

    // Extract domain from URL
    try {
      let domain = urlLower;
      // Remove protocol
      domain = domain.replace(/^https?:\/\//, '');
      // Remove www
      domain = domain.replace(/^www\./, '');
      // Remove path and query params
      domain = domain.split('/')[0].split('?')[0];

      // Check if domain matches any excluded domain
      return excludedDomains.some(excluded =>
        domain === excluded || domain.endsWith('.' + excluded)
      );
    } catch {
      return false;
    }
  };

  // Check if URL contains instagram.com
  const isInstagramUrl = (url: string): boolean => {
    if (!url || typeof url !== 'string') return false;
    const urlLower = url.toLowerCase().trim();
    return urlLower.includes('instagram.com');
  };

  // Get valid URLs from a column (first 5 rows) - for display purposes
  const getValidUrls = (columnName: string, forInstagramColumn: boolean = false): string[] => {
    if (!rows || rows.length === 0) return [];

    // Check first 5 rows (or all rows if less than 5)
    const rowsToCheck = rows.slice(0, 5);
    const validUrls: string[] = [];

    for (const row of rowsToCheck) {
      const value = row[columnName]?.trim() || '';
      if (!value) continue;
      // Skip email-shaped values when looking for domain/URL columns.
      // (Instagram/person modes don't typically contain emails, but excluding
      //  here keeps the preview accurate.)
      if (looksLikeEmail(value)) continue;

      if (allowBoth && forInstagramColumn) {
        // When displaying Instagram column, show all URLs (including Instagram)
        if (value.includes('.') || isInstagramUrl(value)) {
          validUrls.push(value);
        }
      } else if (allowBoth) {
        // When displaying domain column, show non-Instagram URLs
        if (value.includes('.') && !isInstagramUrl(value) && !isExcludedDomain(value)) {
          validUrls.push(value);
        }
      } else if (mode === 'instagram') {
        // In Instagram mode, only include Instagram URLs
        if (isInstagramUrl(value)) {
          validUrls.push(value);
        }
      } else if (mode === 'investor') {
        // In investor mode, accept domain or LinkedIn URLs
        if (value.includes('.') && (value.toLowerCase().includes('linkedin.com') || !isExcludedDomain(value))) {
          validUrls.push(value);
        }
      } else if (mode === 'person') {
        // In person mode, only LinkedIn person profile URLs
        if (/linkedin\.com\/in\//i.test(value)) {
          validUrls.push(value);
        }
      } else {
        // In domain mode, exclude social media domains
        if (value.includes('.')) {
          if (!isExcludedDomain(value)) {
            validUrls.push(value);
          }
        }
      }
    }

    return validUrls;
  };

  // Check if a column contains valid URLs
  const hasValidUrls = (columnName: string): boolean => {
    return getValidUrls(columnName).length > 0;
  };

  // Filter columns: exclude those with no URLs or only social media URLs
  const validColumns = useMemo(() => {
    return columns.filter(column => hasValidUrls(column));
  }, [columns, rows]);

  // Filter columns based on search query
  const filteredColumns = useMemo(() => {
    const columnsToFilter = validColumns;
    if (!searchQuery.trim()) {
      return columnsToFilter;
    }
    const query = searchQuery.toLowerCase().trim();
    return columnsToFilter.filter(column =>
      column.toLowerCase().includes(query)
    );
  }, [validColumns, searchQuery]);

  // Reset search when dialog closes
  React.useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setLocalSelectedColumns(
        selectedColumns ? { ...EMPTY_SELECTED_COLUMNS, ...selectedColumns } : { ...EMPTY_SELECTED_COLUMNS }
      );
      setEditingColumn(null);
      setEditDraft('');
      setRenameError(null);
      autoSelectedKeyRef.current = null;
      touchedSlotsRef.current = new Set();
    }
  }, [isOpen, selectedColumns]);

  // Update local state when selectedColumns prop changes
  React.useEffect(() => {
    if (selectedColumns) {
      setLocalSelectedColumns({ ...EMPTY_SELECTED_COLUMNS, ...selectedColumns });
    }
  }, [selectedColumns]);

  // Separate columns into domain and Instagram columns
  const domainColumns = useMemo(() => {
    if (!allowBoth && mode !== 'investor') return [];
    return columns.filter(column => {
      // Check all rows (not just first 5) to be more thorough
      const rowsToCheck = rows.slice(0, Math.min(10, rows.length));
      let hasNonInstagramUrl = false;

      for (const row of rowsToCheck) {
        const value = row[column]?.trim() || '';
        if (!value) continue;
        // Emails contain dots but are not domain URLs.
        if (looksLikeEmail(value)) continue;

        // Check if it's a URL (contains a dot)
        if (value.includes('.')) {
          // Investor mode: accept domain or LinkedIn
          if (mode === 'investor') {
            if (value.toLowerCase().includes('linkedin.com') || !isExcludedDomain(value)) {
              hasNonInstagramUrl = true;
              break;
            }
          } else if (!isInstagramUrl(value) && !isExcludedDomain(value)) {
            hasNonInstagramUrl = true;
            break;
          }
        }
      }

      return hasNonInstagramUrl;
    });
  }, [columns, rows, allowBoth, mode]);

  const instagramColumns = useMemo(() => {
    if (!allowBoth) return [];
    return columns.filter(column => {
      // Check all rows (not just first 5) to be more thorough
      const rowsToCheck = rows.slice(0, Math.min(10, rows.length));
      let hasInstagramUrl = false;

      for (const row of rowsToCheck) {
        const value = row[column]?.trim() || '';
        if (!value) continue;

        // Check if it's an Instagram URL
        if (isInstagramUrl(value)) {
          hasInstagramUrl = true;
          break;
        }
      }

      return hasInstagramUrl;
    });
  }, [columns, rows, allowBoth]);

  // Detect email-shaped columns: column where the header hints at email OR
  // at least half of the first 10 non-empty values look like emails.
  const emailColumns = useMemo(() => {
    // Detect regardless of researchMode — the Contact Columns section is
    // shown whenever allowBoth is true, so users can map an email column
    // even when researching Instagram or Person profiles.
    const out: string[] = [];
    for (const column of columns) {
      const rowsToCheck = rows.slice(0, Math.min(10, rows.length));
      let nonEmpty = 0;
      let emailLike = 0;
      for (const row of rowsToCheck) {
        const value = row[column]?.trim() || '';
        if (!value) continue;
        nonEmpty++;
        if (looksLikeEmail(value)) emailLike++;
      }
      const headerHint = /e?\s*-?\s*mail/i.test(column);
      if ((nonEmpty > 0 && emailLike / nonEmpty >= 0.5) || (headerHint && emailLike > 0)) {
        out.push(column);
      }
    }
    return out;
  }, [columns, rows, mode]);

  const detectedEmailColumn = emailColumns[0] || null;

  // Person-name columns: header hints or majority of first-10 values look like
  // a 1-4 word human name (no digits, no @, no slashes).
  // Confidence-scored: score columns and return them ordered best-first. We
  // disqualify columns whose values look like URLs/emails, which prevents
  // tracking-laden Apollo/CRM links from being picked as "title" etc.
  const nameColumns = useMemo(() => {
    const headerHintRe = /\b(name|contact|person|full[\s_-]?name|first[\s_-]?name|last[\s_-]?name)\b/i;
    const scored: { column: string; score: number }[] = [];
    for (const column of columns) {
      const headerHint = headerHintRe.test(column);
      const rowsToCheck = rows.slice(0, Math.min(10, rows.length));
      let nonEmpty = 0;
      let nameLike = 0;
      let urlOrEmail = 0;
      for (const row of rowsToCheck) {
        const value = row[column]?.trim() || '';
        if (!value) continue;
        nonEmpty++;
        if (looksLikeUrl(value) || looksLikeEmail(value)) { urlOrEmail++; continue; }
        if (looksLikePersonName(value)) nameLike++;
      }
      if (nonEmpty === 0) continue;
      // Hard reject: any URL/email cell rules a column out from being "name".
      if (urlOrEmail > 0) continue;
      const ratio = nameLike / nonEmpty;
      if (ratio < 0.6 && !headerHint) continue;
      if (headerHint && nameLike === 0) continue;
      const score = ratio * 100 + (headerHint ? 50 : 0);
      scored.push({ column, score });
    }
    return scored.sort((a, b) => b.score - a.score).map(s => s.column);
  }, [columns, rows, mode]);

  const titleColumns = useMemo(() => {
    const headerHintRe = /\b(title|role|designation|position|job[\s_-]?title)\b/i;
    const scored: { column: string; score: number }[] = [];
    for (const column of columns) {
      const headerHint = headerHintRe.test(column);
      const rowsToCheck = rows.slice(0, Math.min(10, rows.length));
      let nonEmpty = 0;
      let titleLike = 0;
      let urlOrEmail = 0;
      for (const row of rowsToCheck) {
        const value = row[column]?.trim() || '';
        if (!value) continue;
        nonEmpty++;
        if (looksLikeUrl(value) || looksLikeEmail(value)) { urlOrEmail++; continue; }
        if (looksLikeTitle(value)) titleLike++;
      }
      if (nonEmpty === 0) continue;
      // Hard reject: URL/email-heavy columns can't be a title column.
      if (urlOrEmail / nonEmpty >= 0.4) continue;
      const ratio = titleLike / nonEmpty;
      // Require either a header hint + at least one keyword match, OR a high
      // value-based ratio (60%). 40% was too permissive and let in noisy cols.
      if (headerHint) {
        if (titleLike === 0) continue;
      } else if (ratio < 0.6) {
        continue;
      }
      const score = ratio * 100 + (headerHint ? 50 : 0);
      scored.push({ column, score });
    }
    return scored.sort((a, b) => b.score - a.score).map(s => s.column);
  }, [columns, rows, mode]);

  const linkedinColumns = useMemo(() => {
    const out: string[] = [];
    for (const column of columns) {
      const rowsToCheck = rows.slice(0, Math.min(10, rows.length));
      let hasProfile = false;
      for (const row of rowsToCheck) {
        const value = row[column]?.trim() || '';
        if (!value) continue;
        if (looksLikeLinkedInProfile(value)) {
          hasProfile = true;
          break;
        }
      }
      if (hasProfile) out.push(column);
    }
    return out;
  }, [columns, rows]);

  // First column is a strong default for "person name" if nothing better matched.
  const fallbackNameColumn = useMemo(() => {
    if (nameColumns.length > 0) return null;
    const first = columns[0];
    if (!first) return null;
    const rowsToCheck = rows.slice(0, Math.min(10, rows.length));
    for (const row of rowsToCheck) {
      const value = row[first]?.trim() || '';
      if (value && looksLikePersonName(value) && !looksLikeEmail(value)) {
        return first;
      }
    }
    return null;
  }, [columns, rows, nameColumns]);

  const detectedNameColumn = nameColumns[0] || fallbackNameColumn || null;
  const detectedTitleColumn = titleColumns[0] || null;
  const detectedLinkedinColumn = linkedinColumns[0] || null;

  // Auto-fill each slot independently as detection produces a value. Previously
  // this effect set a single "already auto-selected" ref keyed on the column
  // list, which meant if rows hydrated (or any other detection input changed)
  // after the first run, slots like email/name/title that weren't yet
  // detectable would never get filled. The new logic:
  //   - fills any slot that is currently null AND the user hasn't touched
  //   - reruns whenever detection results change
  //   - respects user clears via `touchedSlotsRef`
  // Base `next` on the `selectedColumns` prop (the fresh source-of-truth) rather
  // than the closure-captured `localSelectedColumns`. On a second CSV upload,
  // the prop-sync effect queues a reset to all-nulls but it isn't committed
  // before this effect reads its closure — using the prop avoids that staleness.
  useEffect(() => {
    if (!isOpen) return;

    if (allowBoth) {
      const detections: Array<{ kind: keyof SelectedColumnsState; value: string | null }> = [
        { kind: 'domain', value: domainColumns[0] || null },
        { kind: 'instagram', value: instagramColumns[0] || null },
        { kind: 'email', value: detectedEmailColumn },
        { kind: 'name', value: detectedNameColumn },
        { kind: 'title', value: detectedTitleColumn },
        { kind: 'linkedin', value: detectedLinkedinColumn },
      ];
      const base: SelectedColumnsState = selectedColumns
        ? { ...EMPTY_SELECTED_COLUMNS, ...selectedColumns }
        : { ...EMPTY_SELECTED_COLUMNS };
      const next: SelectedColumnsState = { ...base };
      let changed = false;
      for (const { kind, value } of detections) {
        if (!value) continue;
        if (next[kind] !== null) continue;
        if (touchedSlotsRef.current.has(kind)) continue;
        next[kind] = value;
        changed = true;
      }
      if (changed) {
        setLocalSelectedColumns(next);
        onSelectColumns?.(next);
      }
    } else {
      const key = columns.join('|');
      if (autoSelectedKeyRef.current === key) return;
      if (!selectedColumn) {
        const pool = mode === 'investor' ? domainColumns : validColumns;
        if (pool[0]) {
          onSelectColumn(pool[0]);
          autoSelectedKeyRef.current = key;
        }
      } else {
        autoSelectedKeyRef.current = key;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isOpen, columns, rows, allowBoth, mode,
    // selectedColumns prop — needed so a parent-side reset (e.g. on a new CSV
    // upload) re-runs auto-fill against the cleared baseline.
    selectedColumns,
    // Detection results — re-run auto-fill whenever any of them appear or change
    domainColumns, instagramColumns,
    detectedEmailColumn, detectedNameColumn, detectedTitleColumn, detectedLinkedinColumn,
  ]);

  const handleColumnToggle = (column: string, type: 'domain' | 'instagram' | ContactColumnKind) => {
    const newSelected = { ...localSelectedColumns };
    if (newSelected[type] === column) {
      newSelected[type] = null;
    } else {
      newSelected[type] = column;
    }
    touchedSlotsRef.current.add(type);
    setLocalSelectedColumns(newSelected);
    if (onSelectColumns) {
      onSelectColumns(newSelected);
    }
  };

  const startEdit = (column: string) => {
    setEditingColumn(column);
    setEditDraft(column);
    setRenameError(null);
  };

  const cancelEdit = () => {
    setEditingColumn(null);
    setEditDraft('');
    setRenameError(null);
  };

  const commitEdit = () => {
    if (!editingColumn || !onRenameColumn) {
      cancelEdit();
      return;
    }
    const trimmed = editDraft.trim();
    if (!trimmed) {
      setRenameError('Name cannot be empty.');
      return;
    }
    if (trimmed === editingColumn) {
      cancelEdit();
      return;
    }
    if (columns.includes(trimmed)) {
      setRenameError(`A column named "${trimmed}" already exists.`);
      return;
    }
    onRenameColumn(editingColumn, trimmed);
    cancelEdit();
  };

  const renderColumnName = (column: string, opts?: { tag?: string }) => {
    const isEditing = editingColumn === column;
    if (isEditing) {
      return (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <input
            autoFocus
            type="text"
            value={editDraft}
            onChange={(e) => { setEditDraft(e.target.value); if (renameError) setRenameError(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
              else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
            }}
            className="flex-1 min-w-0 px-2 py-1 text-sm border border-brand-default rounded-sm focus:outline-none focus:ring-1 focus:ring-brand-default"
          />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); commitEdit(); }}
            className="text-emerald-600 hover:text-emerald-800 text-sm"
            title="Save (Enter)"
          >
            ✓
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); cancelEdit(); }}
            className="text-red-600 hover:text-red-800 text-sm"
            title="Cancel (Esc)"
          >
            ✕
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 min-w-0">
        <div className="font-medium text-sm truncate">{column}</div>
        {opts?.tag && (
          <span className="text-[10px] uppercase font-semibold text-brand-default bg-brand-default/10 px-1.5 py-0.5 rounded">
            {opts.tag}
          </span>
        )}
        {onRenameColumn && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); startEdit(column); }}
            className="ml-auto text-gray-400 hover:text-brand-default text-xs"
            title="Rename column"
            aria-label={`Rename column ${column}`}
          >
            ✎
          </button>
        )}
      </div>
    );
  };

  if (!isOpen) return null;

  // Allow proceeding with EITHER a domain/instagram column OR a LinkedIn URL
  // column (in which case the parent routes rows through Person Research).
  const canConfirm = allowBoth
    ? (
        localSelectedColumns.domain !== null ||
        localSelectedColumns.instagram !== null ||
        localSelectedColumns.linkedin !== null
      )
    : selectedColumn !== null;

  // "Create domain column from email" is offered when we found an email column
  // AND there's no usable domain column yet (or the user hasn't picked one).
  const noDomainSelected = allowBoth
    ? !localSelectedColumns.domain
    : !selectedColumn;
  const showCreateDomainFromEmail =
    !!onCreateDomainFromEmail &&
    !!detectedEmailColumn &&
    (allowBoth ? domainColumns.length === 0 || noDomainSelected : true) &&
    mode !== 'instagram' && mode !== 'person';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-semibold mb-4">
          {allowBoth ? 'Select Columns' : (mode === 'instagram' ? 'Select Instagram Column' : mode === 'investor' ? 'Select Domain or LinkedIn Column' : 'Select URL Column')}
        </h2>
        <p className="text-gray-600 mb-4">
          {allowBoth
            ? 'Select the domain column and/or Instagram column. You can select both to combine data from both columns.'
            : (mode === 'instagram'
              ? 'Please select the column that contains Instagram URLs. Only columns with Instagram URLs (instagram.com) are shown.'
              : mode === 'investor'
              ? 'Please select the column that contains domains (e.g. boldcap.com) or LinkedIn URLs (e.g. linkedin.com/in/garrytan).'
              : 'Please select the column that contains company website URLs. Columns with no URLs or social media links (LinkedIn, Twitter, Facebook, etc.) are excluded.')}
        </p>

        {/* Create domain from email CTA */}
        {showCreateDomainFromEmail && detectedEmailColumn && (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-sm flex items-start justify-between gap-3">
            <div className="text-xs text-blue-900">
              <p className="font-semibold mb-0.5">No domain column?</p>
              <p>
                Create a new <span className="font-medium">Domain</span> column derived from{' '}
                <span className="font-medium">{detectedEmailColumn}</span> (the part after{' '}
                <code className="px-1 bg-white rounded">@</code>).
              </p>
            </div>
            <button
              type="button"
              onClick={() => onCreateDomainFromEmail?.(detectedEmailColumn)}
              className="flex-shrink-0 px-3 py-1.5 text-xs font-medium bg-brand-default text-white rounded-sm hover:bg-opacity-90"
            >
              Create domain column
            </button>
          </div>
        )}

        {renameError && (
          <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded-sm text-xs text-red-700">
            {renameError}
          </div>
        )}

        {/* Search Input */}
        <div className="mb-4">
          <input
            type="text"
            placeholder="Search columns..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-sm ring-2 ring-brand-default focus:outline-none focus:ring-brand-default"
          />
        </div>

        {allowBoth ? (
          <div className="space-y-6 mb-6">
            {/* Domain Column Selection */}
            <div>
              <h3 className="text-lg font-medium mb-3">Domain Column (Optional)</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {domainColumns.length > 0 ? (
                  domainColumns
                    .filter(column => !searchQuery.trim() || column.toLowerCase().includes(searchQuery.toLowerCase()))
                    .map((column) => {
                      const validUrls = getValidUrls(column, false);
                      const isSelected = localSelectedColumns.domain === column;
                      const isAutoDetected = column === domainColumns[0];
                      return (
                        <div
                          key={column}
                          role="button"
                          tabIndex={0}
                          onClick={() => handleColumnToggle(column, 'domain')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleColumnToggle(column, 'domain');
                            }
                          }}
                          className={`w-full text-left px-4 py-3 rounded-sm border-2 transition-colors cursor-pointer ${
                            isSelected
                              ? 'border-brand-default bg-blue-50 text-gray-900'
                              : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleColumnToggle(column, 'domain')}
                              onClick={(e) => e.stopPropagation()}
                              className="w-4 h-4 flex-shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              {renderColumnName(column, { tag: isAutoDetected ? 'auto' : undefined })}
                            </div>
                          </div>
                          {validUrls.length > 0 && (
                            <div className="mt-2 space-y-1 ml-6">
                              <div className="text-xs text-gray-500 font-medium">
                                Valid URLs found ({validUrls.length}):
                              </div>
                              <div className="space-y-0.5">
                                {validUrls.slice(0, 3).map((url, index) => (
                                  <div
                                    key={index}
                                    className="text-xs text-gray-600 truncate pl-2"
                                    title={url}
                                  >
                                    • {url}
                                  </div>
                                ))}
                                {validUrls.length > 3 && (
                                  <div className="text-xs text-gray-500 pl-2">
                                    ... and {validUrls.length - 3} more
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })
                ) : (
                  <div className="text-center py-4 text-gray-500 text-sm">
                    No domain columns found
                    {detectedEmailColumn && onCreateDomainFromEmail && (
                      <div className="mt-1 text-xs">
                        Use “Create domain column” above to derive one from{' '}
                        <span className="font-medium">{detectedEmailColumn}</span>.
                      </div>
                    )}
                    {detectedLinkedinColumn && (
                      <div className="mt-1 text-xs">
                        Or map the LinkedIn URL column below — rows will be processed via{' '}
                        <span className="font-medium">Person Research</span>.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Instagram Column Selection */}
            <div>
              <h3 className="text-lg font-medium mb-3">Instagram Column (Optional)</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {instagramColumns.length > 0 ? (
                  instagramColumns
                    .filter(column => !searchQuery.trim() || column.toLowerCase().includes(searchQuery.toLowerCase()))
                    .map((column) => {
                      const validUrls = getValidUrls(column, true);
                      const isSelected = localSelectedColumns.instagram === column;
                      return (
                        <div
                          key={column}
                          role="button"
                          tabIndex={0}
                          onClick={() => handleColumnToggle(column, 'instagram')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleColumnToggle(column, 'instagram');
                            }
                          }}
                          className={`w-full text-left px-4 py-3 rounded-sm border-2 transition-colors cursor-pointer ${
                            isSelected
                              ? 'border-brand-default bg-blue-50 text-gray-900'
                              : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleColumnToggle(column, 'instagram')}
                              onClick={(e) => e.stopPropagation()}
                              className="w-4 h-4 flex-shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              {renderColumnName(column)}
                            </div>
                          </div>
                          {validUrls.length > 0 && (
                            <div className="mt-2 space-y-1 ml-6">
                              <div className="text-xs text-gray-500 font-medium">
                                Valid URLs found ({validUrls.length}):
                              </div>
                              <div className="space-y-0.5">
                                {validUrls.slice(0, 3).map((url, index) => (
                                  <div
                                    key={index}
                                    className="text-xs text-gray-600 truncate pl-2"
                                    title={url}
                                  >
                                    • {url}
                                  </div>
                                ))}
                                {validUrls.length > 3 && (
                                  <div className="text-xs text-gray-500 pl-2">
                                    ... and {validUrls.length - 3} more
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })
                ) : (
                  <div className="text-center py-4 text-gray-500 text-sm">
                    No Instagram columns found
                  </div>
                )}
              </div>
            </div>

            {/* Contact Columns Selection */}
            <div>
              <h3 className="text-lg font-medium mb-1">Contact Columns (Optional)</h3>
              <p className="text-xs text-gray-500 mb-3">
                If your CSV has per-row contact details, map them here. They&apos;ll be added as
                contacts on each company. If no domain is selected and a LinkedIn URL column is
                picked, rows will be treated as person profiles.
              </p>
              {(() => {
                const sections: Array<{
                  kind: ContactColumnKind;
                  label: string;
                  description: string;
                  pool: string[];
                  detected: string | null;
                  predicate: (v: string) => boolean;
                  matchedLabel: string;
                  mismatchedLabel: string;
                }> = [
                  {
                    kind: 'email',
                    label: 'Email',
                    description: 'Maps to the contact’s email address.',
                    pool: emailColumns,
                    detected: detectedEmailColumn,
                    predicate: looksLikeEmail,
                    matchedLabel: 'Looks like emails',
                    mismatchedLabel: 'No email-shaped values found',
                  },
                  {
                    kind: 'name',
                    label: 'Person Name',
                    description: 'Full name of the contact.',
                    pool: Array.from(new Set([
                      ...nameColumns,
                      ...(fallbackNameColumn ? [fallbackNameColumn] : []),
                    ])),
                    detected: detectedNameColumn,
                    predicate: (v) => looksLikePersonName(v) && !looksLikeEmail(v) && !v.includes('/') && !v.includes('.com'),
                    matchedLabel: 'Looks like person names',
                    mismatchedLabel: 'Values don’t look like person names',
                  },
                  {
                    kind: 'title',
                    label: 'Title / Role',
                    description: 'Job title (CEO, Head of …, Director, etc.).',
                    pool: titleColumns,
                    detected: detectedTitleColumn,
                    predicate: looksLikeTitle,
                    matchedLabel: 'Looks like job titles',
                    mismatchedLabel: 'No title-like keywords found',
                  },
                  {
                    kind: 'linkedin',
                    label: 'LinkedIn URL',
                    description: 'linkedin.com/in/… profile URL.',
                    pool: linkedinColumns,
                    detected: detectedLinkedinColumn,
                    predicate: looksLikeLinkedInProfile,
                    matchedLabel: 'Looks like LinkedIn URLs',
                    mismatchedLabel: 'No linkedin.com/in URLs found',
                  },
                ];

                const collectSamples = (column: string): { samples: string[]; matches: number; nonEmpty: number } => {
                  const rowsToCheck = rows.slice(0, Math.min(10, rows.length));
                  const samples: string[] = [];
                  let nonEmpty = 0;
                  let matches = 0;
                  for (const r of rowsToCheck) {
                    const v = (r[column] || '').trim();
                    if (!v) continue;
                    nonEmpty++;
                    if (samples.length < 4) samples.push(v);
                  }
                  return { samples, matches, nonEmpty };
                };

                return (
                  <div className="space-y-4">
                    {sections.map((section) => {
                      const value = localSelectedColumns[section.kind] || '';
                      // Always offer every CSV column so the user can override
                      // detection without first clearing the field. Recommended
                      // (auto-detected pool) columns are listed first, then the
                      // remaining columns under an "Other columns" group.
                      const poolSet = new Set(section.pool);
                      const otherColumns = columns.filter(c => !poolSet.has(c));
                      const previewCol = value || section.detected;
                      // Build "columnName — sample1, sample2" labels so users
                      // can identify the right column without opening it first.
                      const buildOptionLabel = (col: string): string => {
                        const rowsToCheck = rows.slice(0, Math.min(10, rows.length));
                        const samples: string[] = [];
                        for (const r of rowsToCheck) {
                          const v = (r[col] || '').trim();
                          if (!v) continue;
                          samples.push(v);
                          if (samples.length >= 2) break;
                        }
                        if (samples.length === 0) return col;
                        const joined = samples
                          .map(s => (s.length > 30 ? s.slice(0, 30) + '…' : s))
                          .join(', ');
                        const trimmed = joined.length > 60 ? joined.slice(0, 60) + '…' : joined;
                        return `${col} — ${trimmed}`;
                      };
                      let preview: { samples: string[]; matches: number; nonEmpty: number } | null = null;
                      if (previewCol) {
                        const stats = collectSamples(previewCol);
                        const matches = stats.samples.filter(section.predicate).length;
                        preview = { samples: stats.samples, matches, nonEmpty: stats.nonEmpty };
                      }
                      return (
                        <div key={section.kind} className="space-y-1.5">
                          <div className="flex flex-col sm:flex-row sm:items-center sm:gap-3 gap-1">
                            <div className="sm:w-40 flex-shrink-0">
                              <div className="text-sm font-medium text-gray-800">{section.label}</div>
                              <div className="text-[11px] text-gray-500">{section.description}</div>
                            </div>
                            <div className="flex-1 flex items-center gap-2 min-w-0">
                              <select
                                value={value}
                                onChange={(e) => {
                                  const next: SelectedColumnsState = {
                                    ...localSelectedColumns,
                                    [section.kind]: e.target.value || null,
                                  };
                                  touchedSlotsRef.current.add(section.kind);
                                  setLocalSelectedColumns(next);
                                  onSelectColumns?.(next);
                                }}
                                className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-gray-300 rounded-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-default"
                              >
                                <option value="">— None —</option>
                                {section.pool.length > 0 && (
                                  <optgroup label="Recommended">
                                    {section.pool.map((col) => (
                                      <option key={`pool-${col}`} value={col}>
                                        {buildOptionLabel(col)}
                                        {col === section.detected ? ' (auto)' : ''}
                                      </option>
                                    ))}
                                  </optgroup>
                                )}
                                {otherColumns.length > 0 && (
                                  <optgroup label={section.pool.length > 0 ? 'Other columns' : 'All columns'}>
                                    {otherColumns.map((col) => (
                                      <option key={`other-${col}`} value={col}>
                                        {buildOptionLabel(col)}
                                      </option>
                                    ))}
                                  </optgroup>
                                )}
                              </select>
                              {value && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next: SelectedColumnsState = {
                                      ...localSelectedColumns,
                                      [section.kind]: null,
                                    };
                                    touchedSlotsRef.current.add(section.kind);
                                    setLocalSelectedColumns(next);
                                    onSelectColumns?.(next);
                                  }}
                                  className="text-xs text-gray-500 hover:text-red-600"
                                  title="Clear selection"
                                >
                                  Clear
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Sample values preview */}
                          {previewCol && preview && (
                            <div className="ml-0 sm:ml-[10.75rem] pl-2 border-l-2 border-gray-100">
                              {preview.samples.length > 0 ? (
                                <>
                                  <div className="text-[11px] text-gray-500 flex items-center gap-2 mb-0.5">
                                    <span className="font-medium">
                                      Sample values from “{previewCol}”
                                      {!value && <span className="text-gray-400"> (auto-detected)</span>}
                                    </span>
                                    {preview.nonEmpty > 0 && (
                                      <span
                                        className={
                                          preview.matches > 0
                                            ? 'text-emerald-600'
                                            : 'text-amber-600'
                                        }
                                        title={`${preview.matches}/${preview.samples.length} sampled values match this column kind`}
                                      >
                                        {preview.matches > 0
                                          ? `✓ ${section.matchedLabel} (${preview.matches}/${preview.samples.length})`
                                          : `⚠ ${section.mismatchedLabel}`}
                                      </span>
                                    )}
                                  </div>
                                  <div className="space-y-0.5">
                                    {preview.samples.map((s, i) => {
                                      const ok = section.predicate(s);
                                      return (
                                        <div
                                          key={i}
                                          className={`text-xs truncate pl-2 ${ok ? 'text-gray-700' : 'text-gray-500'}`}
                                          title={s}
                                        >
                                          • {s}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </>
                              ) : (
                                <p className="text-[11px] text-gray-400 italic">
                                  No non-empty values in “{previewCol}” yet.
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {(localSelectedColumns.email || localSelectedColumns.name || localSelectedColumns.title || localSelectedColumns.linkedin) && (
                      <p className="text-[11px] text-gray-500 mt-2">
                        {localSelectedColumns.domain
                          ? 'Each row will be saved as a contact on the row’s company.'
                          : localSelectedColumns.linkedin
                          ? 'No domain column selected — rows with a LinkedIn URL will be processed as person profiles.'
                          : 'Select a domain column (or a LinkedIn URL column) to attach these contacts to companies.'}
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto mb-6">
            {filteredColumns.length > 0 ? (
              filteredColumns.map((column) => {
                const validUrls = getValidUrls(column);
                const isAutoDetected = column === (mode === 'investor' ? domainColumns[0] : validColumns[0]);
                return (
                  <div
                    key={column}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectColumn(column)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectColumn(column);
                      }
                    }}
                    className={`w-full text-left px-4 py-3 rounded-sm border-2 transition-colors cursor-pointer ${
                      selectedColumn === column
                        ? 'border-brand-default bg-blue-50 text-gray-900'
                        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {renderColumnName(column, { tag: isAutoDetected ? 'auto' : undefined })}
                    {validUrls.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <div className="text-xs text-gray-500 font-medium">
                          Valid URLs found ({validUrls.length}):
                        </div>
                        <div className="space-y-0.5">
                          {validUrls.map((url, index) => (
                            <div
                              key={index}
                              className="text-xs text-gray-600 truncate pl-2"
                              title={url}
                            >
                              • {url}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="text-center py-8 text-gray-500">
                <p>No columns found matching "{searchQuery}"</p>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 border border-gray-300 rounded-sm hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`px-4 py-2 rounded-sm transition-colors ${
              canConfirm
                ? 'bg-brand-default text-white hover:bg-opacity-90'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};

export default ColumnSelectorDialog;
