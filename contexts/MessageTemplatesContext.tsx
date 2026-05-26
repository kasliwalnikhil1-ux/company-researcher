'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '@/utils/supabase/client';
import { useAuth } from './AuthContext';

export type TemplateChannel = 'direct' | 'instagram' | 'email' | 'linkedin' | 'ads' | 'jobs' | 'news' | 'replies';

/**
 * Per-template configuration stored in the `settings` jsonb column.
 *
 * - `variable_defaults`: fallback values for `${var}` placeholders when the
 *   company/investor data does not provide a value for that variable.
 * - `fallback_template_id`: id of another `message_templates` row to render
 *   instead when, after applying defaults, one or more variables are still
 *   missing. Fallback chains are followed recursively (cycles are guarded).
 */
export interface MessageTemplateSettings {
  variable_defaults?: Record<string, string>;
  fallback_template_id?: string | null;
}

export interface MessageTemplate {
  id: string;
  user_id: string;
  title: string;
  template: string; // Single template string with ${variable} syntax
  channel: TemplateChannel;
  category?: string;
  settings?: MessageTemplateSettings | null;
  /** B2B offer key — see OFFER_OPTIONS in lib/messageTemplates.ts. */
  offer?: string | null;
}

export interface PreviewCompany {
  id: string;
  domain: string | null;
  instagram: string | null;
  summary: Record<string, any> | null;
}

export const CHANNEL_LABELS: Record<TemplateChannel, string> = {
  direct: 'Direct',
  instagram: 'Instagram',
  email: 'Email',
  linkedin: 'LinkedIn',
  ads: 'Ads',
  jobs: 'Jobs',
  news: 'News',
  replies: 'Replies',
};

interface MessageTemplatesContextType {
  templates: MessageTemplate[];
  loading: boolean;
  refreshTemplates: () => Promise<void>;
  createTemplate: (template: Omit<MessageTemplate, 'id' | 'user_id'>) => Promise<void>;
  updateTemplate: (id: string, template: Partial<Omit<MessageTemplate, 'id' | 'user_id'>>) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
  previewCompanies: PreviewCompany[];
  previewCompaniesLoading: boolean;
}

const MessageTemplatesContext = createContext<MessageTemplatesContextType | undefined>(undefined);

export const MessageTemplatesProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewCompanies, setPreviewCompanies] = useState<PreviewCompany[]>([]);
  const [previewCompaniesLoading, setPreviewCompaniesLoading] = useState(false);
  const [previewCompaniesFetched, setPreviewCompaniesFetched] = useState(false);

  const fetchTemplates = async () => {
    if (!user) {
      setTemplates([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('message_templates')
        .select('*')
        .eq('user_id', user.id);

      if (error) {
        console.error('Error fetching templates:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        throw error;
      }

      setTemplates(data || []);
    } catch (error) {
      console.error('Error in fetchTemplates:', error);
    } finally {
      setLoading(false);
    }
  };

  const createTemplate = async (template: Omit<MessageTemplate, 'id' | 'user_id'>) => {
    if (!user) throw new Error('User must be logged in');

    const payload: Record<string, any> = {
      user_id: user.id,
      title: template.title,
      template: template.template,
      channel: template.channel,
    };
    if (template.category !== undefined) payload.category = template.category;
    if (template.settings !== undefined) payload.settings = template.settings;
    if (template.offer !== undefined) payload.offer = template.offer;

    const { data, error } = await supabase
      .from('message_templates')
      .insert(payload)
      .select()
      .single();

    if (error) {
      console.error('Error creating template:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
        payload,
      });
      throw new Error(error.message || 'Failed to create template');
    }

    await fetchTemplates();
  };

  const updateTemplate = async (id: string, updates: Partial<Omit<MessageTemplate, 'id' | 'user_id'>>) => {
    if (!user) throw new Error('User must be logged in');

    const { error } = await supabase
      .from('message_templates')
      .update(updates)
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) {
      console.error('Error updating template:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
        id,
        updates,
      });
      throw new Error(error.message || 'Failed to update template');
    }

    await fetchTemplates();
  };

  const deleteTemplate = async (id: string) => {
    if (!user) throw new Error('User must be logged in');

    const { error } = await supabase
      .from('message_templates')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) {
      console.error('Error deleting template:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
        id,
      });
      throw new Error(error.message || 'Failed to delete template');
    }

    await fetchTemplates();
  };

  const fetchPreviewCompanies = async () => {
    if (!user) {
      setPreviewCompanies([]);
      setPreviewCompaniesFetched(false);
      return;
    }

    try {
      setPreviewCompaniesLoading(true);
      const { data, error } = await supabase
        .from('companies')
        .select('id, domain, instagram, summary')
        .eq('user_id', user.id)
        .not('summary', 'is', null)
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) {
        console.error('Error fetching preview companies:', error);
        setPreviewCompanies([]);
      } else {
        setPreviewCompanies((data || []) as PreviewCompany[]);
      }
      setPreviewCompaniesFetched(true);
    } catch (error) {
      console.error('Error in fetchPreviewCompanies:', error);
      setPreviewCompanies([]);
    } finally {
      setPreviewCompaniesLoading(false);
    }
  };

  useEffect(() => {
    if (user) {
      fetchTemplates();
      if (!previewCompaniesFetched) {
        fetchPreviewCompanies();
      }
    } else {
      setTemplates([]);
      setLoading(false);
      setPreviewCompanies([]);
      setPreviewCompaniesFetched(false);
    }
  }, [user]);

  const value: MessageTemplatesContextType = {
    templates,
    loading,
    refreshTemplates: fetchTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    previewCompanies,
    previewCompaniesLoading,
  };

  return (
    <MessageTemplatesContext.Provider value={value}>
      {children}
    </MessageTemplatesContext.Provider>
  );
};

export const useMessageTemplates = () => {
  const context = useContext(MessageTemplatesContext);
  if (context === undefined) {
    throw new Error('useMessageTemplates must be used within a MessageTemplatesProvider');
  }
  return context;
};
