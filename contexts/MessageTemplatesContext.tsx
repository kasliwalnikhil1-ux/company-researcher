'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '@/utils/supabase/client';
import { useAuth } from './AuthContext';

export type TemplateChannel = 'direct' | 'instagram' | 'email' | 'linkedin';

export interface MessageTemplate {
  id: string;
  user_id: string;
  title: string;
  template: string; // Single template string with ${variable} syntax
  channel: TemplateChannel;
}

export const CHANNEL_LABELS: Record<TemplateChannel, string> = {
  direct: 'Direct',
  instagram: 'Instagram',
  email: 'Email',
  linkedin: 'LinkedIn',
};

interface MessageTemplatesContextType {
  templates: MessageTemplate[];
  loading: boolean;
  refreshTemplates: () => Promise<void>;
  createTemplate: (template: Omit<MessageTemplate, 'id' | 'user_id'>) => Promise<void>;
  updateTemplate: (id: string, template: Partial<Omit<MessageTemplate, 'id' | 'user_id'>>) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
}

const MessageTemplatesContext = createContext<MessageTemplatesContextType | undefined>(undefined);

export const MessageTemplatesProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);

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

    const payload = {
      user_id: user.id,
      title: template.title,
      template: template.template,
      channel: template.channel,
    };

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

  useEffect(() => {
    if (user) {
      fetchTemplates();
    } else {
      setTemplates([]);
      setLoading(false);
    }
  }, [user]);

  const value: MessageTemplatesContextType = {
    templates,
    loading,
    refreshTemplates: fetchTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
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
