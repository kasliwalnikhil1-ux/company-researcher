"use client";

import React, { useState, useCallback, useRef, useEffect } from "react";
import { X, Mail, Phone, Linkedin, User, Loader2, Copy, Check, Trash2, ChevronLeft, ChevronRight, Plus, Edit2 } from "lucide-react";
import { Company } from "@/contexts/CompaniesContext";
import { extractPhoneNumber } from "@/lib/utils";
import { buildEmailComposeUrl, buildEmailBody, type EmailSettings } from "@/lib/emailCompose";
import { supabase } from "@/utils/supabase/client";

interface CompanyDetailsDrawerProps {
  isOpen: boolean;
  company: Company | null;
  onClose: () => void;
  getSummaryData: (company: Company) => any;
  columnLabels: Record<string, string>;
  getCellValue: (company: Company, columnKey: string) => string;
  columnOrder: string[];
  updateCompany: (id: string, updates: Partial<Company>) => Promise<void>;
  companies?: Company[];
  onCompanyChange?: (company: Company) => void;
  currentPage?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  emailSettings?: EmailSettings | null;
}

const CompanyDetailsDrawer: React.FC<CompanyDetailsDrawerProps> = ({
  isOpen,
  company,
  onClose,
  getSummaryData,
  columnLabels,
  getCellValue,
  columnOrder,
  updateCompany,
  companies = [],
  onCompanyChange,
  currentPage = 1,
  totalPages = 1,
  onPageChange,
  emailSettings = null,
}) => {
  // Inline editing state
  const [editingCell, setEditingCell] = useState<{
    companyId: string;
    columnKey: string;
    value: string;
  } | null>(null);

  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const [toastMessage, setToastMessage] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [classificationValue, setClassificationValue] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"overview" | "contacts">("overview");
  const [contacts, setContacts] = useState<any[] | null>(null);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactToRemove, setContactToRemove] = useState<{
    contactId: string | number;
    contactName: string;
  } | null>(null);
  
  // Notes management state
  const [notes, setNotes] = useState<Array<{ message: string; date: string }>>([]);
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [editingNoteIndex, setEditingNoteIndex] = useState<number | null>(null);
  const [newNoteMessage, setNewNoteMessage] = useState('');
  const [noteToDelete, setNoteToDelete] = useState<number | null>(null);

  // Handle cell double click (edit)
  const handleCellDoubleClick = useCallback(
    (company: Company, columnKey: string) => {
      // Template columns are read-only
      if (columnKey.startsWith("template_")) {
        return;
      }

      // Domain and instagram are not directly editable (they have special link behavior)
      if (columnKey === "domain" || columnKey === "instagram") {
        return;
      }

      // Classification uses a dropdown, not double-click editing
      if (columnKey === "classification") {
        return;
      }

      // Notes are managed in the Notes section, not via double-click
      if (columnKey === "notes") {
        return;
      }

      const currentValue = getCellValue(company, columnKey);
      setEditingCell({
        companyId: company.id,
        columnKey,
        value: currentValue === "-" ? "" : currentValue,
      });
    },
    [getCellValue]
  );

  // Handle inline edit save
  const handleInlineEditSave = useCallback(async () => {
    if (!editingCell || !company) return;

    const { companyId, columnKey, value } = editingCell;

    try {
      // Handle direct company fields (not in summary)
      if (columnKey === "phone") {
        const cleanedPhone = extractPhoneNumber(value);
        await updateCompany(companyId, { [columnKey]: cleanedPhone });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        return;
      }

      if (columnKey === "email") {
        await updateCompany(companyId, { [columnKey]: value.trim() });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        return;
      }

      if (columnKey === "set_name") {
        await updateCompany(companyId, { [columnKey]: value.trim() || null });
        setEditingCell(null);
        setToastMessage(`${columnLabels[columnKey]} updated successfully`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        return;
      }

      const summaryData = getSummaryData(company);
      const updatedSummary = { ...summaryData };

      // Update the specific field
      switch (columnKey) {
        case "company_summary":
          updatedSummary.company_summary = value;
          break;
        case "company_industry":
          updatedSummary.company_industry = value;
          break;
        case "profile_summary":
          updatedSummary.profile_summary = value;
          break;
        case "profile_industry":
          updatedSummary.profile_industry = value;
          break;
        case "sales_opener_sentence":
          updatedSummary.sales_opener_sentence = value;
          break;
        case "classification":
          if (
            ["QUALIFIED", "NOT_QUALIFIED", "MAYBE", "EXPIRED"].includes(
              value.toUpperCase()
            )
          ) {
            updatedSummary.classification = value.toUpperCase() as
              | "QUALIFIED"
              | "NOT_QUALIFIED"
              | "MAYBE"
              | "EXPIRED";
          }
          break;
        case "confidence_score": {
          const score = parseFloat(value.replace("%", ""));
          if (!isNaN(score) && score >= 0 && score <= 100) {
            updatedSummary.confidence_score = score / 100;
          }
          break;
        }
        case "product_types":
          updatedSummary.product_types = value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          break;
        case "sales_action":
          if (
            ["OUTREACH", "EXCLUDE", "PARTNERSHIP", "MANUAL_REVIEW"].includes(
              value.toUpperCase()
            )
          ) {
            updatedSummary.sales_action = value.toUpperCase() as
              | "OUTREACH"
              | "EXCLUDE"
              | "PARTNERSHIP"
              | "MANUAL_REVIEW";
          }
          break;
      }

      await updateCompany(companyId, { summary: updatedSummary });
      setEditingCell(null);
      setToastMessage(`${columnLabels[columnKey]} updated successfully`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } catch (error: any) {
      console.error("Error updating field:", error);
      setToastMessage(
        `Error updating ${columnLabels[columnKey]}: ${error.message}`
      );
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    }
  }, [editingCell, company, getSummaryData, updateCompany, columnLabels]);

  /**
   * ✅ FIX: Focus ONLY when starting to edit a NEW field.
   * Previously the effect ran on every keystroke (because editingCell.value changes),
   * which kept moving cursor to end.
   */
  useEffect(() => {
    if (!editingCell || !editInputRef.current) return;

    const el = editInputRef.current;

    // Wait for the input to be in the DOM and stable
    requestAnimationFrame(() => {
      el.focus();

      // Put cursor at the end once when edit mode starts
      const length = el.value.length;
      if (typeof (el as any).setSelectionRange === "function") {
        (el as any).setSelectionRange(length, length);
      }
    });
  }, [editingCell?.companyId, editingCell?.columnKey]);

  // Update classification value when company changes
  useEffect(() => {
    if (company) {
      const summaryData = getSummaryData(company);
      const currentClassification = summaryData.classification || "";
      // Map NOT_QUALIFIED to UNQUALIFIED for display
      const displayValue =
        currentClassification === "NOT_QUALIFIED"
          ? "UNQUALIFIED"
          : currentClassification;
      setClassificationValue(displayValue);
    }
  }, [company, company?.summary, getSummaryData]);

  // Handle classification dropdown change
  const handleClassificationChange = useCallback(
    async (newValue: string) => {
      if (!company || !newValue) return;

      // Optimistically update the UI
      setClassificationValue(newValue);

      try {
        const summaryData = getSummaryData(company);
        const updatedSummary = { ...summaryData };

        // Map UNQUALIFIED to NOT_QUALIFIED for database compatibility
        const dbValue = newValue === "UNQUALIFIED" ? "NOT_QUALIFIED" : newValue;

        // Validate and set classification
        if (["QUALIFIED", "NOT_QUALIFIED", "EXPIRED"].includes(dbValue.toUpperCase())) {
          updatedSummary.classification = dbValue.toUpperCase() as
            | "QUALIFIED"
            | "NOT_QUALIFIED"
            | "MAYBE"
            | "EXPIRED";
        } else {
          // Invalid value, revert
          const currentClassification = summaryData.classification || "";
          const displayValue =
            currentClassification === "NOT_QUALIFIED"
              ? "UNQUALIFIED"
              : currentClassification;
          setClassificationValue(displayValue);
          return;
        }

        await updateCompany(company.id, { summary: updatedSummary });
        setToastMessage("Classification updated successfully");
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
      } catch (error: any) {
        console.error("Error updating classification:", error);
        setToastMessage(`Error updating classification: ${error.message}`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);

        // Revert to previous value on error
        const summaryData = getSummaryData(company);
        const currentClassification = summaryData.classification || "";
        const displayValue =
          currentClassification === "NOT_QUALIFIED"
            ? "UNQUALIFIED"
            : currentClassification;
        setClassificationValue(displayValue);
      }
    },
    [company, getSummaryData, updateCompany]
  );

  // Track if we've already fetched contacts for this company/domain
  const fetchedDomainsRef = useRef<Set<string>>(new Set());
  // Track previous tab to only fetch when switching TO contacts tab
  const prevTabRef = useRef<"overview" | "contacts">("overview");

  // Fetch contacts from API or localStorage
  const fetchContacts = useCallback(async () => {
    if (!company?.domain) return;

    const domain = company.domain;
    const storageKey = `contacts_${domain}`;

    // If we've already fetched for this domain, use cached data
    if (fetchedDomainsRef.current.has(domain)) {
      const cachedContacts = localStorage.getItem(storageKey);
      if (cachedContacts) {
        try {
          const parsed = JSON.parse(cachedContacts);
          setContacts(parsed);
          return;
        } catch (e) {
          console.error("Error parsing cached contacts:", e);
        }
      }
      return;
    }

    // Check if contacts exist in company data
    if (company.contacts && Array.isArray(company.contacts)) {
      setContacts(company.contacts);
      localStorage.setItem(storageKey, JSON.stringify(company.contacts));
      fetchedDomainsRef.current.add(domain);
      return;
    }

    // Check localStorage first
    const cachedContacts = localStorage.getItem(storageKey);
    if (cachedContacts) {
      try {
        const parsed = JSON.parse(cachedContacts);
        setContacts(parsed);
        fetchedDomainsRef.current.add(domain);
        return;
      } catch (e) {
        console.error("Error parsing cached contacts:", e);
      }
    }

    setContactsLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      const response = await fetch(
        "https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/people_search",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ domain }),
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch contacts: ${response.statusText}`);
      }

      const data = await response.json();
      const contactsList = data.results || [];

      // Merge with existing company contacts to preserve checked state
      let mergedContacts = contactsList;
      if (company.contacts && Array.isArray(company.contacts)) {
        // Create a map of existing contacts by their identifier
        const existingContactsMap = new Map();
        company.contacts.forEach((existingContact) => {
          const id = existingContact.person_id || existingContact.email || existingContact.full_name;
          if (id) {
            existingContactsMap.set(id, existingContact);
          }
        });

        // Merge: preserve checked state and other properties from existing contacts
        mergedContacts = contactsList.map((newContact: any) => {
          const id = newContact.person_id || newContact.email || newContact.full_name;
          const existingContact = id ? existingContactsMap.get(id) : null;
          if (existingContact) {
            // Merge: keep new contact data but preserve checked state and any other custom fields
            return { ...newContact, checked: existingContact.checked };
          }
          return newContact;
        });
      }

      // Store in localStorage
      localStorage.setItem(storageKey, JSON.stringify(mergedContacts));

      // Mark this domain as fetched
      fetchedDomainsRef.current.add(domain);

      // Set merged contacts
      setContacts(mergedContacts);
    } catch (error: any) {
      console.error("Error fetching contacts:", error);
      setToastMessage(`Error fetching contacts: ${error.message}`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } finally {
      setContactsLoading(false);
    }
  }, [company?.domain]);

  // Fetch contacts only when user switches TO contacts tab (not when drawer opens)
  useEffect(() => {
    // Only fetch if:
    // 1. Current tab is "contacts"
    // 2. Previous tab was NOT "contacts" (i.e., user just switched to contacts)
    // 3. Company domain exists
    if (
      activeTab === "contacts" &&
      prevTabRef.current !== "contacts" &&
      company?.domain
    ) {
      fetchContacts();
    }
    // Update previous tab reference
    prevTabRef.current = activeTab;
  }, [activeTab, company?.domain, fetchContacts]);

  // Track if we've made local notes changes to prevent overwriting
  const notesChangedLocallyRef = useRef(false);

  // Track previous company ID to detect when we switch companies
  const prevCompanyIdRef = useRef<string | null>(null);

  // Reset tab when company changes
  useEffect(() => {
    if (company) {
      const companyIdChanged = prevCompanyIdRef.current !== company.id;
      
      // If company ID changed, reset the local changes flag
      if (companyIdChanged) {
        notesChangedLocallyRef.current = false;
        prevCompanyIdRef.current = company.id;
      }
      
      setActiveTab("overview");
      setContacts(null);
      prevTabRef.current = "overview"; // Reset previous tab reference
      // Don't clear fetchedDomainsRef - we want to keep the cache across company switches
      
      // Only load notes from company if we haven't made local changes
      // This prevents overwriting local state when parent refreshes after our update
      if (!notesChangedLocallyRef.current) {
        if (company.notes && Array.isArray(company.notes)) {
          setNotes(company.notes);
        } else {
          setNotes([]);
        }
      } else {
        // If we have local changes, check if the company prop has been updated to match
        // This happens when the parent refreshes after our update
        const propNotes = company.notes && Array.isArray(company.notes) ? company.notes : [];
        const notesMatch = JSON.stringify(propNotes) === JSON.stringify(notes);
        if (notesMatch) {
          // Parent has synced our changes, reset the flag
          notesChangedLocallyRef.current = false;
        }
      }
      setIsAddingNote(false);
      setEditingNoteIndex(null);
      setNewNoteMessage('');
    } else {
      prevCompanyIdRef.current = null;
      notesChangedLocallyRef.current = false;
    }
  }, [company?.id]);

  // Handle contact checkbox toggle
  const handleContactToggle = useCallback(
    async (contactId: string | number, checked: boolean) => {
      if (!company || !contacts) return;

      try {
        // Update the contact in the array
        const updatedContacts = contacts.map((contact) => {
          // Match by person_id or email or full_name as identifier
          const matches =
            contact.person_id === contactId ||
            contact.email === contactId ||
            contact.full_name === contactId;
          
          if (matches) {
            return { ...contact, checked };
          }
          return contact;
        });

        // Update local state
        setContacts(updatedContacts);

        // Update localStorage cache
        const domain = company.domain;
        const storageKey = `contacts_${domain}`;
        localStorage.setItem(storageKey, JSON.stringify(updatedContacts));

        // Update database
        await updateCompany(company.id, { contacts: updatedContacts });

        setToastMessage(checked ? "Contact checked" : "Contact unchecked");
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 2000);
      } catch (error: any) {
        console.error("Error toggling contact:", error);
        setToastMessage(`Error updating contact: ${error.message}`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        // Revert local state on error
        setContacts(contacts);
      }
    },
    [company, contacts, updateCompany]
  );

  // Handle contact removal confirmation (shows modal)
  const handleContactRemoveClick = useCallback(
    (contactId: string | number, contactName: string) => {
      setContactToRemove({ contactId, contactName });
    },
    []
  );

  // Handle contact removal (actually removes)
  const handleContactRemoveConfirm = useCallback(
    async () => {
      if (!company || !contacts || !contactToRemove) return;

      const { contactId } = contactToRemove;

      try {
        // Filter out the contact
        const updatedContacts = contacts.filter((contact) => {
          const matches =
            contact.person_id === contactId ||
            contact.email === contactId ||
            contact.full_name === contactId;
          return !matches;
        });

        // Update local state
        setContacts(updatedContacts);

        // Update localStorage cache
        const domain = company.domain;
        const storageKey = `contacts_${domain}`;
        localStorage.setItem(storageKey, JSON.stringify(updatedContacts));

        // Update database
        await updateCompany(company.id, { contacts: updatedContacts });

        // Close modal and show success message
        setContactToRemove(null);
        setToastMessage("Contact removed");
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 2000);
      } catch (error: any) {
        console.error("Error removing contact:", error);
        setToastMessage(`Error removing contact: ${error.message}`);
        setToastVisible(true);
        setTimeout(() => setToastVisible(false), 3000);
        // Revert local state on error
        setContacts(contacts);
      }
    },
    [company, contacts, contactToRemove, updateCompany]
  );

  // Handle cancel removal
  const handleContactRemoveCancel = useCallback(() => {
    setContactToRemove(null);
  }, []);

  // Notes management handlers
  const handleAddNote = useCallback(() => {
    setIsAddingNote(true);
    setNewNoteMessage('');
  }, []);

  const handleCancelAddNote = useCallback(() => {
    setIsAddingNote(false);
    setNewNoteMessage('');
  }, []);

  const handleSaveNote = useCallback(async () => {
    if (!company || !newNoteMessage.trim()) return;

    try {
      const updatedNotes = [...notes];
      
      if (editingNoteIndex !== null) {
        // Update existing note - keep original date
        const originalNote = notes[editingNoteIndex];
        updatedNotes[editingNoteIndex] = {
          message: newNoteMessage.trim(),
          date: originalNote.date, // Keep original date when editing
        };
      } else {
        // Add new note - automatically set today's date
        const today = new Date().toISOString().split('T')[0];
        updatedNotes.push({
          message: newNoteMessage.trim(),
          date: today,
        });
      }

      // Sort notes by date (newest first)
      updatedNotes.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      await updateCompany(company.id, { notes: updatedNotes });
      setNotes(updatedNotes);
      notesChangedLocallyRef.current = true;
      
      // Update the company prop if onCompanyChange is available
      if (onCompanyChange) {
        onCompanyChange({ ...company, notes: updatedNotes });
      }
      
      setIsAddingNote(false);
      setEditingNoteIndex(null);
      setNewNoteMessage('');
      setToastMessage(editingNoteIndex !== null ? 'Note updated successfully' : 'Note added successfully');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } catch (error: any) {
      console.error('Error saving note:', error);
      setToastMessage(`Error saving note: ${error.message}`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    }
  }, [company, notes, newNoteMessage, editingNoteIndex, updateCompany]);

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
    if (!company || noteToDelete === null) return;

    try {
      const updatedNotes = notes.filter((_, index) => index !== noteToDelete);
      const finalNotes = updatedNotes.length > 0 ? updatedNotes : null;
      await updateCompany(company.id, { notes: finalNotes });
      setNotes(updatedNotes);
      notesChangedLocallyRef.current = true;
      
      // Update the company prop if onCompanyChange is available
      if (onCompanyChange) {
        onCompanyChange({ ...company, notes: finalNotes });
      }
      
      setNoteToDelete(null);
      setToastMessage('Note deleted successfully');
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
    } catch (error: any) {
      console.error('Error deleting note:', error);
      setToastMessage(`Error deleting note: ${error.message}`);
      setToastVisible(true);
      setTimeout(() => setToastVisible(false), 3000);
      setNoteToDelete(null);
    }
  }, [company, notes, noteToDelete, updateCompany]);

  const handleDeleteNoteCancel = useCallback(() => {
    setNoteToDelete(null);
  }, []);

  // Calculate current index and navigation helpers (must be before early return)
  const currentIndex = company ? companies.findIndex((c) => c.id === company.id) : -1;
  const hasNextInPage = currentIndex < companies.length - 1 && currentIndex >= 0;
  const hasNextPage = currentPage < totalPages;
  const hasNext = hasNextInPage || hasNextPage;
  const hasPreviousPage = currentPage > 1;
  const hasPreviousInPage = currentIndex > 0;
  const hasPrevious = hasPreviousInPage || hasPreviousPage;

  const handlePrevious = useCallback(() => {
    if (!onCompanyChange || !company) return;

    // If we're at the first company of current page, go to previous page
    if (currentIndex === 0 && hasPreviousPage && onPageChange) {
      onPageChange(currentPage - 1);
      // The company will be updated when the new page loads
      return;
    }

    // Otherwise, navigate to previous company in current page
    if (currentIndex > 0) {
      const previousCompany = companies[currentIndex - 1];
      if (previousCompany) {
        onCompanyChange(previousCompany);
      }
    }
  }, [currentIndex, hasPreviousPage, onPageChange, currentPage, onCompanyChange, companies, company]);

  const handleNext = useCallback(() => {
    if (!onCompanyChange || !company) return;

    // If we're at the last company of current page, go to next page
    if (currentIndex === companies.length - 1 && hasNextPage && onPageChange) {
      onPageChange(currentPage + 1);
      // The company will be updated when the new page loads
      return;
    }

    // Otherwise, navigate to next company in current page
    if (currentIndex < companies.length - 1) {
      const nextCompany = companies[currentIndex + 1];
      if (nextCompany) {
        onCompanyChange(nextCompany);
      }
    }
  }, [currentIndex, companies.length, hasNextPage, onPageChange, currentPage, onCompanyChange, company]);

  // Handle keyboard navigation (must be before early return)
  useEffect(() => {
    if (!isOpen || !company) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if no input is focused
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
        return;
      }

      if (e.key === 'ArrowLeft' && hasPrevious) {
        e.preventDefault();
        handlePrevious();
      } else if (e.key === 'ArrowRight' && hasNext) {
        e.preventDefault();
        handleNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, company, hasPrevious, hasNext, handlePrevious, handleNext]);

  // Contact Card Component (needs to be defined before the main component uses it)
  const ContactCard = ({ 
    contact, 
    index,
    onToggle,
    onRemove
  }: { 
    contact: any; 
    index: number;
    onToggle: (contactId: string | number, checked: boolean) => void;
    onRemove: (contactId: string | number, contactName: string) => void;
  }) => {
    const [imageError, setImageError] = useState(false);
    const [copiedItem, setCopiedItem] = useState<string | null>(null);
    const showPlaceholder = !contact.photo_url || imageError;
    
    // Get unique identifier for this contact
    const contactId = contact.person_id || contact.email || contact.full_name || index;
    const isChecked = contact.checked === true;
    const contactName = contact.full_name || `${contact.first_name || ""} ${contact.last_name || ""}`.trim() || contact.email || "Unknown";

    const handleCopy = async (text: string, itemType: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopiedItem(itemType);
        setTimeout(() => setCopiedItem(null), 2000);
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    };

    // Generate compose URL (Gmail or Outlook) with pre-filled fields, using user email_settings
    const getComposeUrl = (email: string): string => {
      if (!company) {
        return `mailto:${email}`;
      }
      const trimmedEmail = email.trim();
      const subjectColumn = typeof window !== 'undefined'
        ? localStorage.getItem('companies-subject-column')
        : null;
      const clipboardColumn = typeof window !== 'undefined'
        ? localStorage.getItem('companies-clipboard-column')
        : null;
      let subject: string | undefined;
      let body: string | undefined;
      if (subjectColumn) {
        try {
          const subjectValue = getCellValue(company, subjectColumn);
          if (subjectValue && subjectValue !== '-') subject = subjectValue;
        } catch (_) {}
      }
      if (clipboardColumn) {
        try {
          const clipboardValue = getCellValue(company, clipboardColumn);
          if (clipboardValue && clipboardValue !== '-') {
            let firstName = '';
            if (contact.first_name) {
              firstName = contact.first_name;
            } else if (contact.full_name) {
              const nameParts = contact.full_name.trim().split(/\s+/);
              firstName = nameParts[0] || '';
            }
            const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
            body = buildEmailBody(clipboardValue, greeting, emailSettings);
          }
        } catch (_) {}
      }
      return buildEmailComposeUrl(trimmedEmail, { subject, body, emailSettings });
    };

    return (
      <div
        className={`border rounded-lg p-4 hover:shadow-md transition-shadow ${
          isChecked ? "border-indigo-500 bg-indigo-50/30" : "border-gray-200"
        }`}
      >
        <div className="flex items-start gap-4">
          <div className="flex items-start gap-2 pt-1">
            <input
              type="checkbox"
              checked={isChecked}
              onChange={(e) => onToggle(contactId, e.target.checked)}
              className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500 cursor-pointer"
              title={isChecked ? "Uncheck contact" : "Check contact"}
            />
          </div>
          <div className="relative w-20 h-20 flex-shrink-0">
            {contact.photo_url && !imageError && (
              <img
                src={contact.photo_url}
                alt={contact.full_name || "Contact"}
                className="w-20 h-20 rounded-full object-cover border-2 border-gray-200"
                onError={() => setImageError(true)}
              />
            )}
            {showPlaceholder && (
              <div className="w-20 h-20 rounded-full bg-indigo-100 flex items-center justify-center border-2 border-gray-200">
                <User className="w-10 h-10 text-indigo-600" />
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <h4 className="text-base font-semibold text-gray-900">
                  {contact.full_name || `${contact.first_name || ""} ${contact.last_name || ""}`.trim() || "Unknown"}
                </h4>
                {contact.title && (
                  <p className="text-sm text-gray-600 mt-1 font-medium">
                    {contact.title}
                  </p>
                )}
                {contact.headline && (
                  <p className="text-sm text-gray-500 mt-1 italic">
                    {contact.headline}
                  </p>
                )}
              </div>
              <button
                onClick={() => onRemove(contactId, contactName)}
                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors flex-shrink-0"
                title="Remove contact"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {contact.email && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <a
                    href={getComposeUrl(contact.email)}
                    onClick={(e) => {
                      e.preventDefault();
                      window.open(getComposeUrl(contact.email), '_blank', 'noopener,noreferrer');
                    }}
                    className="text-indigo-600 hover:text-indigo-800 hover:underline cursor-pointer"
                  >
                    {contact.email}
                  </a>
                  {contact.email_status && (
                    <span
                      className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${
                        contact.email_status === "verified"
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {contact.email_status}
                    </span>
                  )}
                  <button
                    onClick={() => handleCopy(contact.email, `email-${index}`)}
                    className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors flex-shrink-0"
                    title="Copy email"
                  >
                    {copiedItem === `email-${index}` ? (
                      <Check className="w-4 h-4 text-green-600" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>
                </div>
              )}
              {contact.phone && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <a
                    href={`tel:${contact.phone}`}
                    className="text-indigo-600 hover:text-indigo-800 hover:underline"
                  >
                    {contact.phone}
                  </a>
                </div>
              )}
              {contact.linkedin_url && (
                <div className="flex items-center gap-2 text-sm">
                  <Linkedin className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <a
                    href={contact.linkedin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-600 hover:text-indigo-800 hover:underline"
                  >
                    LinkedIn Profile
                  </a>
                  <button
                    onClick={() => handleCopy(contact.linkedin_url, `linkedin-${index}`)}
                    className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors flex-shrink-0"
                    title="Copy LinkedIn URL"
                  >
                    {copiedItem === `linkedin-${index}` ? (
                      <Check className="w-4 h-4 text-green-600" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Early return AFTER all hooks have been called
  if (!isOpen || !company) return null;

  const summaryData = getSummaryData(company);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-white/30 backdrop-blur-sm z-40 transition-opacity duration-300 ${
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className={`fixed right-0 top-0 h-full w-full max-w-4xl bg-white shadow-xl z-50 transform transition-transform duration-300 ease-in-out ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <div className="flex items-center gap-3 flex-wrap flex-1">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-2xl font-semibold text-gray-900">
                  Company Details
                </h2>
                {companies.length > 0 && currentIndex >= 0 && (
                  <span className="text-sm text-gray-500">
                    Company {currentIndex + 1} of {companies.length}
                    {totalPages > 1 && ` • Page ${currentPage} of ${totalPages}`}
                  </span>
                )}
                {company.domain && (
                  <span className="px-2.5 py-1 text-xs font-medium bg-indigo-100 text-indigo-700 rounded-full">
                    {company.domain}
                  </span>
                )}
                {company.instagram && (
                  <span className="px-2.5 py-1 text-xs font-medium bg-pink-100 text-pink-700 rounded-full">
                    {company.instagram}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Navigation Buttons - before close button */}
              {(companies.length > 1 || totalPages > 1) && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={handlePrevious}
                    disabled={!hasPrevious}
                    className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Previous company"
                    title="Previous company (←)"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <button
                    onClick={handleNext}
                    disabled={!hasNext}
                    className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Next company"
                    title="Next company (→)"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>
              )}
              <button
                onClick={onClose}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
                aria-label="Close drawer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-200">
            <button
              onClick={() => setActiveTab("overview")}
              className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === "overview"
                  ? "text-indigo-600 border-b-2 border-indigo-600"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveTab("contacts")}
              className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === "contacts"
                  ? "text-indigo-600 border-b-2 border-indigo-600"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Contacts
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === "overview" ? (
              <div className="space-y-6">
                {/* Basic Information */}
                <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  Basic Information
                </h3>
                <div className="space-y-3">
                  {company.domain && (
                    <div className="border-l-4 border-indigo-500 pl-4">
                      <p className="text-sm font-medium text-gray-500">
                        {columnLabels.domain || "Domain"}
                      </p>
                      <p className="text-sm text-gray-900">{company.domain}</p>
                    </div>
                  )}
                  {company.instagram && (
                    <div className="border-l-4 border-indigo-500 pl-4">
                      <p className="text-sm font-medium text-gray-500">
                        {columnLabels.instagram || "Instagram"}
                      </p>
                      <p className="text-sm text-gray-900">
                        {company.instagram}
                      </p>
                    </div>
                  )}

                  <div className="border-l-4 border-indigo-500 pl-4">
                    <p className="text-sm font-medium text-gray-500">
                      {columnLabels.phone || "Phone"}
                    </p>

                    {editingCell?.companyId === company.id &&
                    editingCell?.columnKey === "phone" ? (
                      <div className="flex items-center gap-2">
                        <input
                          ref={editInputRef as React.RefObject<HTMLInputElement>}
                          type="text"
                          value={editingCell.value}
                          onChange={(e) =>
                            setEditingCell((prev) =>
                              prev ? { ...prev, value: e.target.value } : prev
                            )
                          }
                          onBlur={handleInlineEditSave}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              handleInlineEditSave();
                            } else if (e.key === "Escape") {
                              setEditingCell(null);
                            }
                          }}
                          className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                        <button
                          onClick={handleInlineEditSave}
                          className="text-green-600 hover:text-green-800"
                          title="Save (Enter)"
                        >
                          ✓
                        </button>
                        <button
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setEditingCell(null);
                          }}
                          className="text-red-600 hover:text-red-800"
                          title="Cancel (Esc)"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div 
                        className="space-y-2 cursor-pointer hover:bg-blue-50 p-1 rounded transition-colors"
                        onDoubleClick={() => handleCellDoubleClick(company, "phone")}
                        title="Double click to edit"
                      >
                        {(company.phone || "-").split(',').map((phoneNum, index) => {
                          const trimmedPhone = phoneNum.trim();
                          if (!trimmedPhone || trimmedPhone === '-') return null;
                          const cleanedPhone = trimmedPhone.replace(/[^\d+]/g, '');
                          return (
                            <div key={index} className="flex items-center gap-2">
                              <p className="text-sm text-gray-900 flex-1">{trimmedPhone}</p>
                              <a
                                href={`tel:${cleanedPhone}`}
                                className="p-1.5 rounded-full bg-green-100 text-green-700 hover:bg-green-200 transition-colors flex-shrink-0"
                                title="Call"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Phone className="w-4 h-4" />
                              </a>
                            </div>
                          );
                        })}
                        {(!company.phone || company.phone === '-') && (
                          <p className="text-sm text-gray-900">-</p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="border-l-4 border-indigo-500 pl-4">
                    <p className="text-sm font-medium text-gray-500">
                      {columnLabels.email || "Email"}
                    </p>

                    {editingCell?.companyId === company.id &&
                    editingCell?.columnKey === "email" ? (
                      <div className="flex items-center gap-2">
                        <input
                          ref={editInputRef as React.RefObject<HTMLInputElement>}
                          type="text"
                          value={editingCell.value}
                          onChange={(e) =>
                            setEditingCell((prev) =>
                              prev ? { ...prev, value: e.target.value } : prev
                            )
                          }
                          onBlur={handleInlineEditSave}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              handleInlineEditSave();
                            } else if (e.key === "Escape") {
                              setEditingCell(null);
                            }
                          }}
                          className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                        <button
                          onClick={handleInlineEditSave}
                          className="text-green-600 hover:text-green-800"
                          title="Save (Enter)"
                        >
                          ✓
                        </button>
                        <button
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setEditingCell(null);
                          }}
                          className="text-red-600 hover:text-red-800"
                          title="Cancel (Esc)"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div 
                        className="space-y-2 cursor-pointer hover:bg-blue-50 p-1 rounded transition-colors"
                        onDoubleClick={() => handleCellDoubleClick(company, "email")}
                        title="Double click to edit"
                      >
                        {(company.email || "-").split(',').map((emailAddr, index) => {
                          const trimmedEmail = emailAddr.trim();
                          if (!trimmedEmail || trimmedEmail === '-') return null;
                          const subjectColumn = typeof window !== 'undefined'
                            ? localStorage.getItem('companies-subject-column')
                            : null;
                          const clipboardColumn = typeof window !== 'undefined'
                            ? localStorage.getItem('companies-clipboard-column')
                            : null;
                          let subject: string | undefined;
                          let body: string | undefined;
                          if (subjectColumn) {
                            try {
                              const v = getCellValue(company, subjectColumn);
                              if (v && v !== '-') subject = v;
                            } catch (_) {}
                          }
                          if (clipboardColumn) {
                            try {
                              const v = getCellValue(company, clipboardColumn);
                              if (v && v !== '-') body = buildEmailBody(v, 'Hi, \n\n', emailSettings);
                            } catch (_) {}
                          }
                          const composeUrl = buildEmailComposeUrl(trimmedEmail, { subject, body, emailSettings });
                          return (
                            <div key={index} className="flex items-center gap-2">
                              <a
                                href={composeUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.open(composeUrl, '_blank', 'noopener,noreferrer');
                                }}
                                className="text-sm text-indigo-600 hover:text-indigo-800 hover:underline flex-1"
                                title="Click to open email"
                              >
                                {trimmedEmail}
                              </a>
                            </div>
                          );
                        })}
                        {(!company.email || company.email === '-') && (
                          <p className="text-sm text-gray-900">-</p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="border-l-4 border-indigo-500 pl-4">
                    <p className="text-sm font-medium text-gray-500">
                      {columnLabels.set_name || "Set Name"}
                    </p>

                    {editingCell?.companyId === company.id &&
                    editingCell?.columnKey === "set_name" ? (
                      <div className="flex items-center gap-2">
                        <input
                          ref={editInputRef as React.RefObject<HTMLInputElement>}
                          type="text"
                          value={editingCell.value}
                          onChange={(e) =>
                            setEditingCell((prev) =>
                              prev ? { ...prev, value: e.target.value } : prev
                            )
                          }
                          onBlur={handleInlineEditSave}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              handleInlineEditSave();
                            } else if (e.key === "Escape") {
                              setEditingCell(null);
                            }
                          }}
                          className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                        <button
                          onClick={handleInlineEditSave}
                          className="text-green-600 hover:text-green-800"
                          title="Save (Enter)"
                        >
                          ✓
                        </button>
                        <button
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setEditingCell(null);
                          }}
                          className="text-red-600 hover:text-red-800"
                          title="Cancel (Esc)"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <p
                        className="text-sm text-gray-900 cursor-pointer hover:bg-blue-50 p-1 rounded transition-colors"
                        onDoubleClick={() => handleCellDoubleClick(company, "set_name")}
                        title="Double click to edit"
                      >
                        {company.set_name || "-"}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Notes Section */}
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-gray-900">
                    Notes
                  </h3>
                  {!isAddingNote && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleAddNote();
                      }}
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
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Message
                        </label>
                        <div className="flex flex-wrap gap-2 mb-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setNewNoteMessage('Not Picked');
                            }}
                            className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                          >
                            Not Picked
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setNewNoteMessage('Interested');
                            }}
                            className="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-300 rounded-md hover:bg-green-100 transition-colors"
                          >
                            Interested
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setNewNoteMessage('Not Interested');
                            }}
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
                          <p className="mt-1 text-xs text-gray-500">
                            Date will be automatically set to today
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            editingNoteIndex !== null ? handleCancelEditNote() : handleCancelAddNote();
                          }}
                          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleSaveNote();
                          }}
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
                            <p className="text-sm text-gray-900 whitespace-pre-wrap">
                              {note.message}
                            </p>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleEditNote(index);
                              }}
                              className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                              title="Edit note"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleDeleteNoteClick(index);
                              }}
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
                      <p className="text-sm text-gray-600">No notes yet. Click "Add Note" to create one.</p>
                    </div>
                  )
                )}
              </div>

              {/* Summary Data */}
              {((summaryData && Object.keys(summaryData).length > 0) ||
                columnOrder.includes("classification")) && (
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">
                    Summary Data
                  </h3>

                  <div className="space-y-3">
                    {columnOrder
                      .filter((column) => {
                        // Only show columns that are not domain/instagram/phone/email/notes (already shown above or separately)
                        if (
                          column === "domain" ||
                          column === "instagram" ||
                          column === "phone" ||
                          column === "email" ||
                          column === "notes"
                        )
                          return false;

                        return true;
                      })
                      .map((columnKey) => {
                        const value = getCellValue(company, columnKey);
                        const isClassification = columnKey === "classification";

                        // Always show classification field (even if empty) so users can set it
                        // For other fields, hide if empty
                        if (!isClassification && (value === "-" || !value))
                          return null;

                        const label = columnLabels[columnKey] || columnKey;
                        const isLongText = value.length > 100;
                        const classificationValueLocal = isClassification
                          ? value.toUpperCase()
                          : "";

                        const getClassificationColorClasses = () => {
                          if (isClassification) {
                            if (classificationValueLocal === "QUALIFIED") {
                              return "bg-green-50 text-green-700 border-green-200";
                            } else if (classificationValueLocal === "NOT_QUALIFIED") {
                              return "bg-red-50 text-red-700 border-red-200";
                            } else if (classificationValueLocal === "EXPIRED") {
                              return "bg-amber-50 text-amber-700 border-amber-200";
                            }
                          }
                          return "bg-gray-50 border-gray-200";
                        };

                        const isEditing =
                          editingCell?.companyId === company.id &&
                          editingCell?.columnKey === columnKey;

                        const isEditable =
                          !columnKey.startsWith("template_") &&
                          columnKey !== "domain" &&
                          columnKey !== "instagram";

                        const isTextareaField =
                          columnKey === "company_summary" ||
                          columnKey === "sales_opener_sentence";

                        // Special handling for classification field - use dropdown
                        if (isClassification) {
                          return (
                            <div
                              key={columnKey}
                              className={`border-l-4 pl-4 py-2 rounded-r ${getClassificationColorClasses()}`}
                            >
                              <p className="text-sm font-medium text-gray-700 mb-1">
                                {label}
                              </p>

                              <select
                                value={classificationValue}
                                onChange={(e) =>
                                  handleClassificationChange(e.target.value)
                                }
                                className={`w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                                  classificationValue === "QUALIFIED"
                                    ? "bg-green-50 text-green-700 border-green-300"
                                    : classificationValue === "UNQUALIFIED" ||
                                      classificationValue === "NOT_QUALIFIED"
                                    ? "bg-red-50 text-red-700 border-red-300"
                                    : classificationValue === "EXPIRED"
                                    ? "bg-amber-50 text-amber-700 border-amber-300"
                                    : "bg-gray-50 border-gray-300"
                                } font-semibold`}
                              >
                                <option value="">Select classification...</option>
                                <option value="QUALIFIED">QUALIFIED</option>
                                <option value="UNQUALIFIED">UNQUALIFIED</option>
                                <option value="EXPIRED">EXPIRED</option>
                              </select>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={columnKey}
                            className={`border-l-4 pl-4 py-2 rounded-r ${getClassificationColorClasses()}`}
                          >
                            <p className="text-sm font-medium text-gray-700 mb-1">
                              {label}
                            </p>

                            {isEditing ? (
                              <div className="flex items-start gap-2">
                                {isTextareaField ? (
                                  <textarea
                                    ref={
                                      editInputRef as React.RefObject<HTMLTextAreaElement>
                                    }
                                    value={editingCell.value}
                                    onChange={(e) =>
                                      setEditingCell((prev) =>
                                        prev
                                          ? { ...prev, value: e.target.value }
                                          : prev
                                      )
                                    }
                                    onBlur={handleInlineEditSave}
                                    onKeyDown={(e) => {
                                      if (
                                        e.key === "Enter" &&
                                        (e.metaKey || e.ctrlKey)
                                      ) {
                                        handleInlineEditSave();
                                      } else if (e.key === "Escape") {
                                        setEditingCell(null);
                                      }
                                    }}
                                    className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                    rows={3}
                                  />
                                ) : (
                                  <input
                                    ref={
                                      editInputRef as React.RefObject<HTMLInputElement>
                                    }
                                    type="text"
                                    value={editingCell.value}
                                    onChange={(e) =>
                                      setEditingCell((prev) =>
                                        prev
                                          ? { ...prev, value: e.target.value }
                                          : prev
                                      )
                                    }
                                    onBlur={handleInlineEditSave}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        handleInlineEditSave();
                                      } else if (e.key === "Escape") {
                                        setEditingCell(null);
                                      }
                                    }}
                                    className="flex-1 px-2 py-1 text-sm border border-indigo-500 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                  />
                                )}

                                <div className="flex flex-col gap-1">
                                  <button
                                    onClick={handleInlineEditSave}
                                    className="text-green-600 hover:text-green-800"
                                    title="Save (Enter)"
                                  >
                                    ✓
                                  </button>
                                  <button
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      setEditingCell(null);
                                    }}
                                    className="text-red-600 hover:text-red-800"
                                    title="Cancel (Esc)"
                                  >
                                    ✕
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <p
                                className={`text-sm ${
                                  isClassification
                                    ? classificationValueLocal === "QUALIFIED" ||
                                      classificationValueLocal === "NOT_QUALIFIED" ||
                                      classificationValueLocal === "EXPIRED"
                                      ? "font-semibold"
                                      : ""
                                    : "text-gray-900"
                                } ${isLongText ? "whitespace-pre-wrap break-words" : ""} ${
                                  isEditable
                                    ? "cursor-pointer hover:bg-blue-50 p-1 rounded transition-colors"
                                    : ""
                                }`}
                                onDoubleClick={
                                  isEditable
                                    ? () =>
                                        handleCellDoubleClick(company, columnKey)
                                    : undefined
                                }
                                title={isEditable ? "Double click to edit" : undefined}
                              >
                                {value}
                              </p>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  Metadata
                </h3>
                <div className="space-y-3">
                  <div className="border-l-4 border-indigo-500 pl-4">
                    <p className="text-sm font-medium text-gray-500">ID</p>
                    <p className="text-sm text-gray-900 font-mono">
                      {company.id}
                    </p>
                  </div>

                  {company.created_at && (
                    <div className="border-l-4 border-indigo-500 pl-4">
                      <p className="text-sm font-medium text-gray-500">
                        Created At
                      </p>
                      <p className="text-sm text-gray-900">
                        {new Date(company.created_at).toLocaleString()}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
            ) : (
              /* Contacts Tab */
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">
                    Contacts
                  </h3>
                  {contactsLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
                      <span className="ml-2 text-gray-600">Loading contacts...</span>
                    </div>
                  ) : contacts && contacts.length > 0 ? (
                    <div className="grid gap-4">
                      {contacts.map((contact, index) => (
                        <ContactCard 
                          key={contact.person_id || index} 
                          contact={contact} 
                          index={index}
                          onToggle={handleContactToggle}
                          onRemove={handleContactRemoveClick}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <User className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                      <p className="text-gray-600">No contacts found for this company.</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-6 border-t border-gray-200">
            <button
              onClick={onClose}
              className="w-full px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      {toastVisible && (
        <div className="fixed bottom-4 right-4 bg-gray-900 text-white px-4 py-2 rounded-md shadow-lg z-50 transition-opacity duration-300">
          {toastMessage}
        </div>
      )}

      {/* Remove Contact Confirmation Modal */}
      {contactToRemove && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] transition-opacity duration-300"
            onClick={handleContactRemoveCancel}
          />
          
          {/* Modal */}
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div
              className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 transform transition-all"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Remove Contact
              </h3>
              <p className="text-sm text-gray-600 mb-6">
                Are you sure you want to remove <span className="font-semibold text-gray-900">{contactToRemove.contactName}</span> from the contacts list? This action cannot be undone.
              </p>
              
              <div className="flex gap-3 justify-end">
                <button
                  onClick={handleContactRemoveCancel}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleContactRemoveConfirm}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Delete Note Confirmation Modal */}
      {noteToDelete !== null && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] transition-opacity duration-300"
            onClick={handleDeleteNoteCancel}
          />
          
          {/* Modal */}
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div
              className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 transform transition-all"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Delete Note
              </h3>
              <p className="text-sm text-gray-600 mb-6">
                Are you sure you want to delete this note? This action cannot be undone.
                {notes[noteToDelete] && (
                  <div className="mt-3 p-3 bg-gray-50 rounded border border-gray-200">
                    <p className="text-xs text-gray-500 mb-1">
                      {new Date(notes[noteToDelete].date).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </p>
                    <p className="text-sm text-gray-900">
                      {notes[noteToDelete].message}
                    </p>
                  </div>
                )}
              </p>
              
              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleDeleteNoteCancel();
                  }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleDeleteNoteConfirm();
                  }}
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

export default CompanyDetailsDrawer;
