'use client';

import { useState, useEffect, useRef } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { useRouter } from 'next/navigation';
import { supabase } from '@/utils/supabase/client';
import Toast from '@/components/ui/Toast';
import { getValidAccessToken } from '@/lib/api';
import {
  DEFAULT_LINKEDIN_GENERATE_REPLY_SYSTEM_PROMPT,
  DEFAULT_LINKEDIN_INTRO,
  DEFAULT_LINKEDIN_CONTEXT,
  DEFAULT_LINKEDIN_HANDOVER_RULES,
  buildLinkedinGenerateReplyPrompt,
} from './linkedinGenerateReplyDefault';
import {
  DEFAULT_INVESTOR_SYSTEM_PROMPT,
  DEFAULT_INVESTOR_USER_MESSAGE_TEMPLATE,
  DEFAULT_INVESTOR_TWITTER_PROMPT,
  DEFAULT_INVESTOR_NEWS_PROMPT,
  DEFAULT_B2B_NEWS_PROMPT,
  DEFAULT_B2B_ADS_PROMPT,
  DEFAULT_JOBS_RESEARCH_QUERY,
  DEFAULT_JOBS_RESEARCH_SCHEMA,
} from './investorAnalyzeDefault';

const PERSONALIZATION_ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

export default function PersonalizationPage() {
  const { user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (user && !PERSONALIZATION_ALLOWED_USER_IDS.has(user.id)) {
      router.replace('/');
    }
  }, [user, router]);

  const canAccess = user && PERSONALIZATION_ALLOWED_USER_IDS.has(user.id);

  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          {canAccess && <PersonalizationContent />}
        </div>
      </MainLayout>
    </ProtectedRoute>
  );
}

interface PersonalizationData {
  direct: {
    query: string;
    schema: string; // JSON string
  };
  instagram: {
    systemPrompt: string;
    userMessage: string;
  };
  linkedinConversations: {
    intro: string;
    context: string;
    handoverRules: string;
    systemPrompt?: string | null;
  };
  investorAnalyze: {
    systemPrompt: string;
    userMessage: string;
  };
  investorTwitter: {
    prompt: string;
  };
  investorNews: {
    prompt: string;
  };
  b2bNews: {
    prompt: string;
  };
  b2bAds: {
    prompt: string;
  };
  jobsResearch: {
    query: string;
    schema: string; // JSON string
  };
}

function PersonalizationContent() {
  const { user } = useAuth();
  const { onboarding } = useOnboarding();
  const primaryUse = onboarding?.flowType ?? onboarding?.step0?.primaryUse ?? 'fundraising';
  const isB2B = primaryUse === 'b2b';
  const isFundraising = primaryUse === 'fundraising';
  const [activeTab, setActiveTab] = useState<'direct' | 'instagram' | 'linkedinConversations' | 'investorAnalyze' | 'investorTwitter' | 'investorNews' | 'b2bNews' | 'b2bAds' | 'jobsResearch'>('linkedinConversations');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);
  const [testSlots, setTestSlots] = useState<
    {
      input: string;
      loading: boolean;
      result: {
        action?: string;
        message?: string | null;
        stage?: string;
        error?: string;
      } | null;
    }[]
  >(() =>
    Array.from({ length: 10 }, () => ({
      input: '',
      loading: false,
      result: null,
    })),
  );
  const linkedinIntroRef = useRef<HTMLTextAreaElement | null>(null);
  const linkedinContextRef = useRef<HTMLTextAreaElement | null>(null);
  const linkedinHandoverRulesRef = useRef<HTMLTextAreaElement | null>(null);
  const investorSystemRef = useRef<HTMLTextAreaElement | null>(null);
  const investorUserRef = useRef<HTMLTextAreaElement | null>(null);
  const investorTwitterRef = useRef<HTMLTextAreaElement | null>(null);
  const investorNewsRef = useRef<HTMLTextAreaElement | null>(null);
  const b2bNewsRef = useRef<HTMLTextAreaElement | null>(null);
  const b2bAdsRef = useRef<HTMLTextAreaElement | null>(null);
  const testReplyRefs = useRef<Array<HTMLTextAreaElement | null>>([]);

  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;

    const scrollableAncestors: HTMLElement[] = [];
    let parent = el.parentElement;
    while (parent) {
      const style = window.getComputedStyle(parent);
      const hasScrollableY =
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        parent.scrollHeight > parent.clientHeight;
      if (hasScrollableY) {
        scrollableAncestors.push(parent);
      }
      parent = parent.parentElement;
    }

    const previousAncestorScroll = scrollableAncestors.map((node) => node.scrollTop);
    const previousWindowScrollY = window.scrollY;

    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;

    scrollableAncestors.forEach((node, idx) => {
      node.scrollTop = previousAncestorScroll[idx];
    });
    window.scrollTo({ top: previousWindowScrollY });
  };

  useEffect(() => {
    testReplyRefs.current.forEach((el) => {
      if (el) {
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
      }
    });
  }, [testSlots]);
  const [formData, setFormData] = useState<PersonalizationData>({
    direct: {
      query: '',
      schema: '',
    },
    instagram: {
      systemPrompt: '',
      userMessage: '',
    },
    linkedinConversations: {
      intro: '',
      context: '',
      handoverRules: '',
    },
    investorAnalyze: {
      systemPrompt: DEFAULT_INVESTOR_SYSTEM_PROMPT,
      userMessage: DEFAULT_INVESTOR_USER_MESSAGE_TEMPLATE,
    },
    investorTwitter: {
      prompt: DEFAULT_INVESTOR_TWITTER_PROMPT,
    },
    investorNews: {
      prompt: DEFAULT_INVESTOR_NEWS_PROMPT,
    },
    b2bNews: {
      prompt: DEFAULT_B2B_NEWS_PROMPT,
    },
    b2bAds: {
      prompt: DEFAULT_B2B_ADS_PROMPT,
    },
    jobsResearch: {
      query: DEFAULT_JOBS_RESEARCH_QUERY,
      schema: DEFAULT_JOBS_RESEARCH_SCHEMA,
    },
  });
  const [initialFormData, setInitialFormData] = useState<PersonalizationData | null>(null);
  const isDirty = initialFormData ? JSON.stringify(formData) !== JSON.stringify(initialFormData) : false;
  const saveDisabled = saving || !isDirty || ((activeTab === 'direct' || activeTab === 'jobsResearch') && schemaError !== null);

  useEffect(() => {
    if (loading) return;
    if (!['linkedinConversations', 'investorAnalyze', 'investorTwitter', 'investorNews', 'b2bNews', 'b2bAds'].includes(activeTab)) return;
    autoGrow(linkedinIntroRef.current);
    autoGrow(linkedinContextRef.current);
    autoGrow(linkedinHandoverRulesRef.current);
    autoGrow(investorSystemRef.current);
    autoGrow(investorUserRef.current);
    autoGrow(investorTwitterRef.current);
    autoGrow(investorNewsRef.current);
    autoGrow(b2bNewsRef.current);
    autoGrow(b2bAdsRef.current);
  }, [activeTab, loading]);

  // Default values
  const defaultDirectQuery = "You are a sales qualification assistant for a company that sells an AI software service to fashion/apparel/jewelry BRANDS that sell PHYSICAL products.\n\nYour job: classify the input company as:\n- QUALIFIED (sells physical fashion/apparel/jewelry products)\n- NOT_QUALIFIED (does NOT sell physical products; or is software/SaaS/IT/service provider)\n- MAYBE (unclear)\n\nCRITICAL RULE:\nOnly mark QUALIFIED if the company sells PHYSICAL consumer products (apparel, jewelry, accessories, etc.) to customers.\nIf the company sells software, SaaS, IT services, consulting, agencies, marketplaces, manufacturing/export services, or is a tool/vendor/provider, it is NOT_QUALIFIED.\n\nReturn STRICT JSON only following the schema.\nQualification Rules\nQUALIFIED ✅\n\nMark QUALIFIED only if you see some evidence of physical product commerce in the profile, such as:\n- product categories mentioned in bio (e.g., \"shirts\", \"kurtas\", \"rings\", \"earrings\")\n- shop links, website links, or e-commerce indicators\n- product-focused content in bio\n- brand/store indicators\n- fashion/apparel/jewelry business signals\n- fashion/apparel/jewelry Manufacturer / exporter / OEM / ODM / supplier / wholesaler\n- fashion/apparel/jewelry marketplace indicators (e.g., \"shop on Amazon\", \"shop on Flipkart\", \"shop on Myntra\", \"shop on Etsy\")\n\nNOT_QUALIFIED ❌\n\nMark NOT_QUALIFIED if ANY are true:\n- Sells software subscription / Is SaaS / Is app / Is AI tool\n- \"We provide services to brands\" (not selling products, like IT services / marketing agency / consulting)\n\nOnly return product_types when classification = \"QUALIFIED\".\n\nproduct_types must be EXACTLY 2 items:\n- generic physical product types (e.g., \"earrings\", \"rings\", \"kurtas\", \"shirts\")\n- NOT \"apparel\", \"jewelry\", \"fashion\" (too broad)\n- NOT services (\"photoshoots\", \"videography\")\n- NOT software (\"platform\", \"tool\", \"API\")\n\nIf you cannot find 2 real product types on the website text, then:\n- classification must be MAYBE (not QUALIFIED)\n- product_types must be null\n- sales_opener_sentence: Message to send to founder, follow exact sentence structure, starting with I think your...\n\nemail and phone as strings if present on the website else null";

  const defaultDirectSchema = JSON.stringify({
    description: "Schema for company qualification assessment with classification and recommended actions",
    type: "object",
    required: ["company_summary", "sales_opener_sentence", "company_industry", "classification", "confidence_score", "product_types", "sales_action", "email", "phone"],
    additionalProperties: false,
    properties: {
      company_summary: {
        type: "string",
        description: "Brief summary of the company"
      },
      company_industry: {
        type: "string",
        description: "Industry of the company like apparel, jewelry, fashion, etc."
      },
      sales_opener_sentence: {
        type: "string",
        description: "I think your [usp, specialization, history // anything ] unique/impressive/special/different/etc. We can use this to start the conversation. Follow the exact sentence structure. <10 words only"
      },
      classification: {
        type: "string",
        enum: ["QUALIFIED", "NOT_QUALIFIED", "MAYBE"],
        description: "Qualification status of the company"
      },
      confidence_score: {
        type: "number",
        description: "Confidence level in the classification assessment"
      },
      product_types: {
        type: "array",
        description: "List of product types associated with the company",
        items: {
          type: "string"
        }
      },
      sales_action: {
        type: "string",
        enum: ["OUTREACH", "EXCLUDE", "PARTNERSHIP", "MANUAL_REVIEW"],
        description: "Recommended sales action to take"
      },
      email: {
        type: "string",
        description: "Email address if present on the website, else empty string"
      },
      phone: {
        type: "string",
        description: "Phone number if present on the website, else empty string"
      }
    }
  }, null, 2);

  const defaultInstagramSystemPrompt = `You are a sales qualification assistant for a company that sells an AI software service to fashion/apparel/jewelry BRANDS that sell PHYSICAL products.

Your job: classify the input Instagram profile as:
- QUALIFIED (sells physical fashion/apparel/jewelry products)
- NOT_QUALIFIED (does NOT sell physical products; or is software/SaaS/IT/service provider)

CRITICAL RULE:
Only mark QUALIFIED if the profile represents a brand/company that sells PHYSICAL consumer products (apparel, jewelry, accessories, etc.) to customers.
If the profile is for software, SaaS, IT services, consulting, agencies, marketplaces, manufacturing/export services, or is a tool/vendor/provider, it is NOT_QUALIFIED.

Reply as a JSON object with keys: 
{sales_opener_sentence: 
classification: QUALIFIED, NOT_QUALIFIED
product_types: Array of product types [""]
sales_action: OUTREACH, EXCLUDE, PARTNERSHIP, MANUAL_REVIEW
email: string (empty string if not present)
phone: string (empty string if not present)
}

Qualification Rules
QUALIFIED ✅

Mark QUALIFIED only if you see some evidence of physical product commerce in the profile, such as:
- product categories mentioned in bio (e.g., "shirts", "kurtas", "rings", "earrings")
- shop links, website links, or e-commerce indicators
- product-focused content in bio
- brand/store indicators
- fashion/apparel/jewelry business signals
- fashion/apparel/jewelry Manufacturer / exporter / OEM / ODM / supplier / wholesaler
- fashion/apparel/jewelry marketplace indicators (e.g., "shop on Amazon", "shop on Flipkart", "shop on Myntra", "shop on Etsy")

NOT_QUALIFIED ❌

Mark NOT_QUALIFIED if ANY are true:
- Sells software subscription / Is SaaS / Is app / Is AI tool
- "We provide services to brands" (not selling products, like IT services / marketing agency / consulting)

Only return product_types when classification = "QUALIFIED".

product_types must be 1 item:
- generic physical product type (e.g., "earrings", "rings", "kurtas", "shirts", "jewelry", "clothing")
- NOT services ("photoshoots", "videography")
- NOT software ("platform", "tool", "API")

sales_opener_sentence: Message to send to founder, follow exact sentence structure, starting with "I think your..."
[usp, specialization, history // anything ] unique/impressive/stunning/special/different/etc, <10 words only.
Don't use words that feel AI like captivating, captivating, transforming, etc.

email and phone as strings if present in bio, otherwise use empty string ""`;

  const defaultInstagramUserMessage = `Analyze this Instagram profile and provide qualification assessment:

Instagram Profile Data:
- Username: {username}
- Full Name: {full_name}
- Biography: {biography}
- Is Private: {is_private}
- Posts Count: {posts_count}
- Followers: {followers}
- Following: {following}
- Profile Picture URL: {profile_pic_url}

Return the assessment in the exact JSON schema format.`;

  // Validate JSON schema
  const validateSchema = (schemaString: string): boolean => {
    if (!schemaString.trim()) {
      setSchemaError('Schema cannot be empty');
      return false;
    }

    try {
      const parsed = JSON.parse(schemaString);
      
      // Basic validation - check if it's an object
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setSchemaError('Schema must be a valid JSON object');
        return false;
      }

      // Check for required schema properties
      if (!parsed.type && !parsed.properties) {
        setSchemaError('Schema should have at least "type" or "properties" field');
        return false;
      }

      setSchemaError(null);
      return true;
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Invalid JSON';
      setSchemaError(`Invalid JSON: ${error}`);
      return false;
    }
  };

  // Fetch personalization settings
  useEffect(() => {
    const fetchPersonalization = async () => {
      if (!user) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const { data, error } = await supabase
          .from('user_settings')
          .select('personalization')
          .eq('id', user.id)
          .single();

        // PGRST116 = no rows returned (user hasn't set personalization yet)
        if (error && error.code === 'PGRST116') {
          // No personalization set yet, use defaults
          const defaultData: PersonalizationData = {
            direct: {
              query: defaultDirectQuery,
              schema: defaultDirectSchema,
            },
            instagram: {
              systemPrompt: defaultInstagramSystemPrompt,
              userMessage: defaultInstagramUserMessage,
            },
            linkedinConversations: {
              intro: DEFAULT_LINKEDIN_INTRO,
              context: DEFAULT_LINKEDIN_CONTEXT,
              handoverRules: DEFAULT_LINKEDIN_HANDOVER_RULES,
            },
            investorAnalyze: {
              systemPrompt: DEFAULT_INVESTOR_SYSTEM_PROMPT,
              userMessage: DEFAULT_INVESTOR_USER_MESSAGE_TEMPLATE,
            },
            investorTwitter: {
              prompt: DEFAULT_INVESTOR_TWITTER_PROMPT,
            },
            investorNews: {
              prompt: DEFAULT_INVESTOR_NEWS_PROMPT,
            },
            b2bNews: {
              prompt: DEFAULT_B2B_NEWS_PROMPT,
            },
            b2bAds: {
              prompt: DEFAULT_B2B_ADS_PROMPT,
            },
            jobsResearch: {
              query: DEFAULT_JOBS_RESEARCH_QUERY,
              schema: DEFAULT_JOBS_RESEARCH_SCHEMA,
            },
          };
          setFormData(defaultData);
          setInitialFormData(defaultData);
          // Validate default schema
          if (defaultData.direct.schema) {
            validateSchema(defaultData.direct.schema);
          }
        } else if (error) {
          // Other error occurred
          console.error('Error fetching personalization:', error);
          // Use defaults on error
          const fallbackData = {
            direct: {
              query: defaultDirectQuery,
              schema: defaultDirectSchema,
            },
            instagram: {
              systemPrompt: defaultInstagramSystemPrompt,
              userMessage: defaultInstagramUserMessage,
            },
            linkedinConversations: {
              intro: DEFAULT_LINKEDIN_INTRO,
              context: DEFAULT_LINKEDIN_CONTEXT,
              handoverRules: DEFAULT_LINKEDIN_HANDOVER_RULES,
            },
            investorAnalyze: {
              systemPrompt: DEFAULT_INVESTOR_SYSTEM_PROMPT,
              userMessage: DEFAULT_INVESTOR_USER_MESSAGE_TEMPLATE,
            },
            investorTwitter: {
              prompt: DEFAULT_INVESTOR_TWITTER_PROMPT,
            },
            investorNews: {
              prompt: DEFAULT_INVESTOR_NEWS_PROMPT,
            },
            b2bNews: {
              prompt: DEFAULT_B2B_NEWS_PROMPT,
            },
            b2bAds: {
              prompt: DEFAULT_B2B_ADS_PROMPT,
            },
            jobsResearch: {
              query: DEFAULT_JOBS_RESEARCH_QUERY,
              schema: DEFAULT_JOBS_RESEARCH_SCHEMA,
            },
          };
          setFormData(fallbackData);
          setInitialFormData(fallbackData);
        } else if (data?.personalization) {
          // Personalization exists, load it
          const parsed = typeof data.personalization === 'string' 
            ? JSON.parse(data.personalization) 
            : data.personalization;

          const loadedData: PersonalizationData = {
            direct: {
              query: parsed.direct?.query || defaultDirectQuery,
              schema: parsed.direct?.schema || defaultDirectSchema,
            },
            instagram: {
              systemPrompt: parsed.instagram?.systemPrompt || defaultInstagramSystemPrompt,
              userMessage: parsed.instagram?.userMessage || defaultInstagramUserMessage,
            },
            linkedinConversations: {
              intro: parsed.linkedinConversations?.intro || DEFAULT_LINKEDIN_INTRO,
              context: parsed.linkedinConversations?.context || DEFAULT_LINKEDIN_CONTEXT,
              handoverRules: parsed.linkedinConversations?.handoverRules || DEFAULT_LINKEDIN_HANDOVER_RULES,
              systemPrompt: parsed.linkedinConversations?.systemPrompt ?? DEFAULT_LINKEDIN_GENERATE_REPLY_SYSTEM_PROMPT,
            },
            investorAnalyze: {
              systemPrompt: parsed.investorAnalyze?.systemPrompt || DEFAULT_INVESTOR_SYSTEM_PROMPT,
              userMessage: parsed.investorAnalyze?.userMessage || DEFAULT_INVESTOR_USER_MESSAGE_TEMPLATE,
            },
            investorTwitter: {
              prompt: parsed.investorTwitter?.prompt || DEFAULT_INVESTOR_TWITTER_PROMPT,
            },
            investorNews: {
              prompt: parsed.investorNews?.prompt || DEFAULT_INVESTOR_NEWS_PROMPT,
            },
            b2bNews: {
              prompt: parsed.b2bNews?.prompt || DEFAULT_B2B_NEWS_PROMPT,
            },
            b2bAds: {
              prompt: parsed.b2bAds?.prompt || DEFAULT_B2B_ADS_PROMPT,
            },
            jobsResearch: {
              query: parsed.jobsResearch?.query || DEFAULT_JOBS_RESEARCH_QUERY,
              schema: parsed.jobsResearch?.schema || DEFAULT_JOBS_RESEARCH_SCHEMA,
            },
          };

          setFormData(loadedData);
          setInitialFormData(loadedData);
          
          // Validate schema if it exists
          if (loadedData.direct.schema) {
            validateSchema(loadedData.direct.schema);
          }
        } else {
          // No personalization data, use defaults
          const defaults = {
            direct: {
              query: defaultDirectQuery,
              schema: defaultDirectSchema,
            },
            instagram: {
              systemPrompt: defaultInstagramSystemPrompt,
              userMessage: defaultInstagramUserMessage,
            },
            linkedinConversations: {
              intro: DEFAULT_LINKEDIN_INTRO,
              context: DEFAULT_LINKEDIN_CONTEXT,
              handoverRules: DEFAULT_LINKEDIN_HANDOVER_RULES,
            },
            investorAnalyze: {
              systemPrompt: DEFAULT_INVESTOR_SYSTEM_PROMPT,
              userMessage: DEFAULT_INVESTOR_USER_MESSAGE_TEMPLATE,
            },
            investorTwitter: {
              prompt: DEFAULT_INVESTOR_TWITTER_PROMPT,
            },
            investorNews: {
              prompt: DEFAULT_INVESTOR_NEWS_PROMPT,
            },
            b2bNews: {
              prompt: DEFAULT_B2B_NEWS_PROMPT,
            },
            b2bAds: {
              prompt: DEFAULT_B2B_ADS_PROMPT,
            },
            jobsResearch: {
              query: DEFAULT_JOBS_RESEARCH_QUERY,
              schema: DEFAULT_JOBS_RESEARCH_SCHEMA,
            },
          };
          setFormData(defaults);
          setInitialFormData(defaults);
        }
      } catch (error) {
        console.error('Error in fetchPersonalization:', error);
        // Use defaults on error
        const errorDefaults = {
          direct: {
            query: defaultDirectQuery,
            schema: defaultDirectSchema,
          },
          instagram: {
            systemPrompt: defaultInstagramSystemPrompt,
            userMessage: defaultInstagramUserMessage,
          },
          linkedinConversations: {
            intro: DEFAULT_LINKEDIN_INTRO,
            context: DEFAULT_LINKEDIN_CONTEXT,
            handoverRules: DEFAULT_LINKEDIN_HANDOVER_RULES,
          },
          investorAnalyze: {
            systemPrompt: DEFAULT_INVESTOR_SYSTEM_PROMPT,
            userMessage: DEFAULT_INVESTOR_USER_MESSAGE_TEMPLATE,
          },
          investorTwitter: {
            prompt: DEFAULT_INVESTOR_TWITTER_PROMPT,
          },
          investorNews: {
            prompt: DEFAULT_INVESTOR_NEWS_PROMPT,
          },
          b2bNews: {
            prompt: DEFAULT_B2B_NEWS_PROMPT,
          },
          b2bAds: {
            prompt: DEFAULT_B2B_ADS_PROMPT,
          },
          jobsResearch: {
            query: DEFAULT_JOBS_RESEARCH_QUERY,
            schema: DEFAULT_JOBS_RESEARCH_SCHEMA,
          },
        };
        setFormData(errorDefaults);
        setInitialFormData(errorDefaults);
      } finally {
        setLoading(false);
      }
    };

    fetchPersonalization();
  }, [user]);

  const handleSave = async () => {
    if (!user) {
      setToastMessage('You must be logged in to save personalization settings.');
      setShowToast(true);
      return;
    }

    try {
      setSaving(true);

      // Validate JSON schema for direct tab
      if (activeTab === 'direct') {
        if (!validateSchema(formData.direct.schema)) {
          setToastMessage('Invalid JSON schema. Please fix the errors before saving.');
          setShowToast(true);
          setSaving(false);
          return;
        }
      }

      // Validate JSON schema for jobs research tab
      if (activeTab === 'jobsResearch') {
        if (!validateSchema(formData.jobsResearch.schema)) {
          setToastMessage('Invalid JSON schema. Please fix the errors before saving.');
          setShowToast(true);
          setSaving(false);
          return;
        }
      }

      const intro =
        (formData.linkedinConversations.intro || DEFAULT_LINKEDIN_INTRO).trim();
      const context =
        (formData.linkedinConversations.context || DEFAULT_LINKEDIN_CONTEXT).trim();
      const handoverRules =
        (formData.linkedinConversations.handoverRules || DEFAULT_LINKEDIN_HANDOVER_RULES).trim();

      const linkedinSystemPrompt = buildLinkedinGenerateReplyPrompt(
        intro,
        context,
        handoverRules,
      );

        const personalizationData = {
        direct: {
          query: formData.direct.query,
          schema: formData.direct.schema,
        },
        instagram: {
          systemPrompt: formData.instagram.systemPrompt,
          userMessage: formData.instagram.userMessage,
        },
        linkedinConversations: {
          intro,
          context,
          handoverRules,
          systemPrompt: linkedinSystemPrompt,
        },
        investorAnalyze: {
          systemPrompt: formData.investorAnalyze.systemPrompt,
          userMessage: formData.investorAnalyze.userMessage,
        },
        investorTwitter: {
          prompt: formData.investorTwitter?.prompt ?? DEFAULT_INVESTOR_TWITTER_PROMPT,
        },
        investorNews: {
          prompt: formData.investorNews?.prompt ?? DEFAULT_INVESTOR_NEWS_PROMPT,
        },
        b2bNews: {
          prompt: formData.b2bNews?.prompt ?? DEFAULT_B2B_NEWS_PROMPT,
        },
        b2bAds: {
          prompt: formData.b2bAds?.prompt ?? DEFAULT_B2B_ADS_PROMPT,
        },
        jobsResearch: {
          query: formData.jobsResearch?.query ?? DEFAULT_JOBS_RESEARCH_QUERY,
          schema: formData.jobsResearch?.schema ?? DEFAULT_JOBS_RESEARCH_SCHEMA,
        },
      };

      // Fetch existing user_settings to preserve other columns
      const { data: existing } = await supabase
        .from('user_settings')
        .select('owners, email_settings, onboarding, column_settings')
        .eq('id', user.id)
        .single();

      // Upsert user settings
      const { error } = await supabase
        .from('user_settings')
        .upsert({
          id: user.id,
          personalization: personalizationData,
          owners: existing?.owners ?? null,
          email_settings: existing?.email_settings ?? null,
          onboarding: existing?.onboarding ?? null,
          column_settings: existing?.column_settings ?? null,
        }, {
          onConflict: 'id'
        });

      if (error) {
        console.error('Error saving personalization:', error);
        throw new Error(error.message || 'Failed to save personalization settings');
      }

      // Mark current saved state as the new baseline
      setInitialFormData(personalizationData);
      setToastMessage('Personalization settings saved successfully!');
      setShowToast(true);
    } catch (error: any) {
      console.error('Error saving personalization:', error);
      setToastMessage(`Error saving personalization: ${error.message}`);
      setShowToast(true);
    } finally {
      setSaving(false);
    }
  };

  const handleTestLinkedinPrompt = async (index: number) => {
    const slot = testSlots[index];
    if (!user) {
      setToastMessage('You must be logged in to run a test.');
      setShowToast(true);
      return;
    }

    if (!slot.input.trim()) {
      setToastMessage('Please paste a LinkedIn conversation to test.');
      setShowToast(true);
      return;
    }

    try {
      setTestSlots((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], loading: true, result: null };
        return next;
      });

      const token = await getValidAccessToken();
      if (!token) {
        setToastMessage('Not authenticated. Please sign in again.');
        setShowToast(true);
        return;
      }

      const res = await fetch('/api/linkedin-conversations/generate-reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          conversation_history: '',
          user_message: slot.input,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = data?.error || `Test failed (${res.status})`;
        setTestSlots((prev) => {
          const next = [...prev];
          next[index] = {
            ...next[index],
            loading: false,
            result: { error: msg },
          };
          return next;
        });
        setToastMessage(msg);
        setShowToast(true);
        return;
      }

      setTestSlots((prev) => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          loading: false,
          result: {
            action: data.action,
            message: data.message,
            stage: data.stage,
          },
        };
        return next;
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to run test';
      setTestSlots((prev) => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          loading: false,
          result: { error: msg },
        };
        return next;
      });
      setToastMessage(msg);
      setShowToast(true);
    }
  };

  const handleTestAllLinkedinPrompts = async () => {
    if (!user) {
      setToastMessage('You must be logged in to run tests.');
      setShowToast(true);
      return;
    }

    const hasAnyInput = testSlots.some((slot) => slot.input.trim());
    if (!hasAnyInput) {
      setToastMessage('Please paste at least one LinkedIn conversation to test.');
      setShowToast(true);
      return;
    }

    const token = await getValidAccessToken();
    if (!token) {
      setToastMessage('Not authenticated. Please sign in again.');
      setShowToast(true);
      return;
    }

    setTestSlots((prev) =>
      prev.map((slot) =>
        slot.input.trim()
          ? { ...slot, loading: true, result: null }
          : slot,
      ),
    );

    await Promise.all(
      testSlots.map(async (slot, index) => {
        if (!slot.input.trim()) return;

        try {
          const res = await fetch('/api/linkedin-conversations/generate-reply', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              conversation_history: '',
              user_message: slot.input,
            }),
          });

          const data = await res.json().catch(() => ({}));

          if (!res.ok) {
            const msg = data?.error || `Test failed (${res.status})`;
            setTestSlots((prev) => {
              const next = [...prev];
              next[index] = {
                ...next[index],
                loading: false,
                result: { error: msg },
              };
              return next;
            });
            return;
          }

          setTestSlots((prev) => {
            const next = [...prev];
            next[index] = {
              ...next[index],
              loading: false,
              result: {
                action: data.action,
                message: data.message,
                stage: data.stage,
              },
            };
            return next;
          });
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : 'Failed to run test';
          setTestSlots((prev) => {
            const next = [...prev];
            next[index] = {
              ...next[index],
              loading: false,
              result: { error: msg },
            };
            return next;
          });
        }
      }),
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-3.5rem)] md:min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">Personalization</h1>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saveDisabled}
            className={`inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white ${
              saveDisabled ? 'bg-gray-300 hover:bg-gray-300 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'
            } focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6">
        <div className="relative border-b border-gray-200 flex-shrink-0">
          <div className="flex gap-0.5 sm:gap-1 px-2 sm:px-4 pt-2 overflow-x-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
            <button
              onClick={() => {
                setActiveTab('linkedinConversations');
                setSchemaError(null);
              }}
              className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                activeTab === 'linkedinConversations'
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Conversations
            </button>
            {isB2B && (
              <button
                onClick={() => {
                  setActiveTab('direct');
                  // Validate schema when switching to direct tab
                  if (formData.direct.schema.trim()) {
                    validateSchema(formData.direct.schema);
                  } else {
                    setSchemaError(null);
                  }
                }}
                className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                  activeTab === 'direct'
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Direct
              </button>
            )}
            {isB2B && (
              <button
                onClick={() => {
                  setActiveTab('instagram');
                  // Clear schema error when switching away from direct tab
                  setSchemaError(null);
                }}
                className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                  activeTab === 'instagram'
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Instagram
              </button>
            )}
            {isB2B && (
              <button
                onClick={() => {
                  setActiveTab('b2bNews');
                  setSchemaError(null);
                }}
                className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                  activeTab === 'b2bNews'
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                News
              </button>
            )}
            {isB2B && (
              <button
                onClick={() => {
                  setActiveTab('b2bAds');
                  setSchemaError(null);
                }}
                className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                  activeTab === 'b2bAds'
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Ads
              </button>
            )}
            {isB2B && (
              <button
                onClick={() => {
                  setActiveTab('jobsResearch');
                  if (formData.jobsResearch.schema.trim()) {
                    validateSchema(formData.jobsResearch.schema);
                  } else {
                    setSchemaError(null);
                  }
                }}
                className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                  activeTab === 'jobsResearch'
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Jobs
              </button>
            )}
            {isFundraising && (
              <button
                onClick={() => {
                  setActiveTab('investorAnalyze');
                  setSchemaError(null);
                }}
                className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                  activeTab === 'investorAnalyze'
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Investor Analyze
              </button>
            )}
            {isFundraising && (
              <button
                onClick={() => {
                  setActiveTab('investorTwitter');
                  setSchemaError(null);
                }}
                className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                  activeTab === 'investorTwitter'
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Investor Twitter
              </button>
            )}
            {isFundraising && (
              <button
                onClick={() => {
                  setActiveTab('investorNews');
                  setSchemaError(null);
                }}
                className={`px-2.5 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0 ${
                  activeTab === 'investorNews'
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Investor News
              </button>
            )}

            {/* Spacer to ensure last tab isn't clipped by fade on mobile */}
            <div className="flex-shrink-0 w-4 sm:hidden" aria-hidden="true" />
          </div>
          {/* Right fade indicator for overflowing tabs on mobile */}
          <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-white to-transparent pointer-events-none sm:hidden" />
        </div>
      </div>

      {/* Direct Tab */}
      {activeTab === 'direct' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Query</h2>
            <textarea
              value={formData.direct.query}
              onChange={(e) => setFormData({
                ...formData,
                direct: { ...formData.direct, query: e.target.value }
              })}
              rows={20}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm"
              placeholder="Enter your qualification query..."
            />
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Schema (JSON)</h2>
            <textarea
              value={formData.direct.schema}
              onChange={(e) => {
                const newSchema = e.target.value;
                setFormData({
                  ...formData,
                  direct: { ...formData.direct, schema: newSchema }
                });
                // Validate schema in real-time
                if (newSchema.trim()) {
                  validateSchema(newSchema);
                } else {
                  setSchemaError(null);
                }
              }}
              onBlur={() => {
                // Validate on blur as well
                if (formData.direct.schema.trim()) {
                  validateSchema(formData.direct.schema);
                }
              }}
              rows={30}
              className={`block w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm ${
                schemaError ? 'border-red-300 focus:border-red-500 focus:ring-red-500' : 'border-gray-300'
              }`}
              placeholder="Enter your JSON schema..."
            />
            {schemaError && (
              <p className="mt-2 text-sm text-red-600 bg-red-50 p-2 rounded">
                {schemaError}
              </p>
            )}
            {!schemaError && formData.direct.schema.trim() && (
              <p className="mt-2 text-sm text-green-600 bg-green-50 p-2 rounded">
                ✓ Valid JSON schema
              </p>
            )}
            <p className="mt-2 text-xs text-gray-500">
              The schema must be valid JSON. Use placeholders like {"{"}username{"}"}, {"{"}biography{"}"} for dynamic values.
            </p>
          </div>
        </div>
      )}

      {/* Instagram Tab */}
      {activeTab === 'instagram' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">System Prompt</h2>
            <textarea
              value={formData.instagram.systemPrompt}
              onChange={(e) => setFormData({
                ...formData,
                instagram: { ...formData.instagram, systemPrompt: e.target.value }
              })}
              rows={25}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm"
              placeholder="Enter your system prompt..."
            />
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">User Message</h2>
            <textarea
              value={formData.instagram.userMessage}
              onChange={(e) => setFormData({
                ...formData,
                instagram: { ...formData.instagram, userMessage: e.target.value }
              })}
              rows={15}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm"
              placeholder="Enter your user message template..."
            />
            <p className="mt-2 text-xs text-gray-500">
              Use placeholders like {"{"}username{"}"}, {"{"}full_name{"}"}, {"{"}biography{"}"}, {"{"}is_private{"}"}, {"{"}posts_count{"}"}, {"{"}followers{"}"}, {"{"}following{"}"}, {"{"}profile_pic_url{"}"} for dynamic values.
            </p>
          </div>
        </div>
      )}

      {/* LinkedIn Conversations Tab */}
      {activeTab === 'linkedinConversations' && (
        <div className="space-y-6">
          {/* Prompt builder card */}
          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              LinkedIn AI System Prompt
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              Build, test, and deploy your autonomous AI sales agent.
            </p>

            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-gray-800 mb-2">INTRO</h3>
                <textarea
                  ref={linkedinIntroRef}
                  value={formData.linkedinConversations.intro}
                  onChange={(e) => {
                    autoGrow(e.currentTarget);
                    setFormData({
                      ...formData,
                      linkedinConversations: {
                        ...formData.linkedinConversations,
                        intro: e.target.value,
                      },
                    });
                  }}
                  rows={1}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm resize-none overflow-hidden"
                  placeholder={DEFAULT_LINKEDIN_INTRO}
                />
              </div>

              <div>
                <h3 className="text-sm font-semibold text-gray-800 mb-2">CONTEXT</h3>
                <textarea
                  ref={linkedinContextRef}
                  value={formData.linkedinConversations.context}
                  onChange={(e) => {
                    autoGrow(e.currentTarget);
                    setFormData({
                      ...formData,
                      linkedinConversations: {
                        ...formData.linkedinConversations,
                        context: e.target.value,
                      },
                    });
                  }}
                  rows={1}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm resize-none overflow-hidden"
                  placeholder={DEFAULT_LINKEDIN_CONTEXT}
                />
              </div>

              <div>
                <h3 className="text-sm font-semibold text-gray-800 mb-2">
                  HANDOVER RULES
                </h3>
                <textarea
                  ref={linkedinHandoverRulesRef}
                  value={formData.linkedinConversations.handoverRules}
                  onChange={(e) => {
                    autoGrow(e.currentTarget);
                    setFormData({
                      ...formData,
                      linkedinConversations: {
                        ...formData.linkedinConversations,
                        handoverRules: e.target.value,
                      },
                    });
                  }}
                  rows={1}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm resize-none overflow-hidden"
                  placeholder={DEFAULT_LINKEDIN_HANDOVER_RULES}
                />
              </div>
            </div>
          </div>

          {/* Test area card */}
          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900 mb-2">
              Test with a conversation
            </h2>
            <p className="text-xs text-gray-500 mb-2">
              Paste up to 10 LinkedIn conversations and generate replies using your
              current saved settings.
            </p>

            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] text-gray-500">
                You can test up to 10 conversations in parallel.
              </p>
              <button
                type="button"
                onClick={async () => {
                  await handleTestAllLinkedinPrompts();
                }}
                className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                Test All
              </button>
            </div>

            <div className="space-y-4">
              {testSlots.map((slot, index) => (
                <div
                  key={index}
                  className="border border-gray-100 rounded-md p-3 bg-gray-50/50"
                >
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[11px] font-semibold text-gray-700">
                      Conversation {index + 1}
                    </p>
                    <button
                      type="button"
                      onClick={() => handleTestLinkedinPrompt(index)}
                      disabled={slot.loading || !slot.input.trim()}
                      className="inline-flex items-center px-2.5 py-0.5 border border-transparent text-[11px] font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-1 focus:ring-offset-1 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {slot.loading ? 'Testing...' : 'Test'}
                    </button>
                  </div>
                  <textarea
                    value={slot.input}
                    onChange={(e) =>
                      setTestSlots((prev) => {
                        const next = [...prev];
                        next[index] = {
                          ...next[index],
                          input: e.target.value,
                        };
                        return next;
                      })
                    }
                    rows={4}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-xs mb-2"
                    placeholder={
                      index === 0
                        ? `Prospect: Hi, I'm interested in learning more about CapitalxAI...\nYou: Great to hear that!`
                        : 'Paste a LinkedIn conversation...'
                    }
                  />

                  {slot.result && (
                    <div className="mt-1 space-y-1">
                      {slot.result.error ? (
                        <p className="text-[11px] text-red-600">
                          Error: {slot.result.error}
                        </p>
                      ) : (
                        <>
                          <p className="text-[11px] text-gray-700">
                            <span className="font-semibold">Action:</span>{' '}
                            {slot.result.action || '(none)'}
                            {'  '}
                            <span className="font-semibold ml-3">Stage:</span>{' '}
                            {slot.result.stage || '(none)'}
                          </p>
                          {typeof slot.result.message === 'string' && (
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <p className="text-[11px] font-semibold text-gray-700">
                                  Generated Reply
                                </p>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      await navigator.clipboard.writeText(
                                        slot.result?.message || '',
                                      );
                                      setToastMessage(
                                        'Reply copied to clipboard.',
                                      );
                                      setShowToast(true);
                                    } catch {
                                      setToastMessage(
                                        'Failed to copy to clipboard.',
                                      );
                                      setShowToast(true);
                                    }
                                  }}
                                  className="text-[11px] px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                                >
                                  Copy
                                </button>
                              </div>
                              <textarea
                                ref={(el) => {
                                  testReplyRefs.current[index] = el;
                                  if (el) autoGrow(el);
                                }}
                                readOnly
                                value={slot.result.message || ''}
                                rows={1}
                                className="block w-full px-3 py-2 border border-gray-200 rounded-md bg-gray-50 font-mono text-[11px] resize-none overflow-hidden"
                              />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Investor Analyze Tab */}
      {activeTab === 'investorAnalyze' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Investor Analyze Prompts</h2>
            <p className="text-sm text-gray-500 mb-4">
              Edit the system prompt and user message template used by the Investor Analyze AI.
            </p>

            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-gray-800 mb-2">System Prompt</h3>
                <textarea
                  ref={investorSystemRef}
                  value={formData.investorAnalyze.systemPrompt}
                  onChange={(e) => {
                    autoGrow(e.currentTarget);
                    setFormData({
                      ...formData,
                      investorAnalyze: {
                        ...formData.investorAnalyze,
                        systemPrompt: e.target.value,
                      },
                    });
                  }}
                  rows={6}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm resize-none overflow-hidden"
                  placeholder={DEFAULT_INVESTOR_SYSTEM_PROMPT}
                />
              </div>

              <div>
                <h3 className="text-sm font-semibold text-gray-800 mb-2">User Message Template</h3>
                <textarea
                  ref={investorUserRef}
                  value={formData.investorAnalyze.userMessage}
                  onChange={(e) => {
                    autoGrow(e.currentTarget);
                    setFormData({
                      ...formData,
                      investorAnalyze: {
                        ...formData.investorAnalyze,
                        userMessage: e.target.value,
                      },
                    });
                  }}
                  rows={10}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm resize-none overflow-hidden"
                  placeholder={DEFAULT_INVESTOR_USER_MESSAGE_TEMPLATE}
                />
                <p className="mt-2 text-xs text-gray-500">
                  Use placeholders: {"{"}COMPANY_CONTEXT{"}"}, {"{"}DEEP_RESEARCH{"}"}, {"{"}COMPANY_NAME{"}"} (use exact tokens like &lt;&lt;&lt;DEEP_RESEARCH&gt;&gt;&gt; in templates).
                </p>
              </div>
              {/* Twitter prompt moved to its own tab */}
            </div>
          </div>
        </div>
      )}

      {/* Investor Twitter Tab */}
      {activeTab === 'investorTwitter' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Investor Twitter Icebreaker</h2>
            <p className="text-sm text-gray-500 mb-4">
              Edit the Twitter icebreaker prompt used to generate one-line tweets-based icebreakers.
            </p>

            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-gray-800 mb-2">Twitter Icebreaker Prompt</h3>
                <textarea
                  ref={investorTwitterRef}
                  value={formData.investorTwitter?.prompt ?? ''}
                  onChange={(e) => {
                    autoGrow(e.currentTarget);
                    setFormData((prev) => ({
                      ...prev,
                      investorTwitter: {
                        ...(prev?.investorTwitter ?? { prompt: DEFAULT_INVESTOR_TWITTER_PROMPT }),
                        prompt: e.target.value,
                      },
                    }));
                  }}
                  rows={6}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm resize-none overflow-hidden"
                  placeholder={DEFAULT_INVESTOR_TWITTER_PROMPT}
                />
                <p className="mt-2 text-xs text-gray-500">
                  Use placeholders: {"{"}name{"}"}, {"{"}first_name{"}"}, {"{"}allValidTweets{"}"}, {"{"}dateString{"}"}.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Investor News Tab */}
      {activeTab === 'investorNews' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Investor News</h2>
            <p className="text-sm text-gray-500 mb-4">
              Edit the system prompt used to fetch the latest news, updates, and activity for an investor.
            </p>

            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-gray-800 mb-2">News System Prompt</h3>
                <textarea
                  ref={investorNewsRef}
                  value={formData.investorNews?.prompt ?? ''}
                  onChange={(e) => {
                    autoGrow(e.currentTarget);
                    setFormData((prev) => ({
                      ...prev,
                      investorNews: {
                        ...(prev?.investorNews ?? { prompt: DEFAULT_INVESTOR_NEWS_PROMPT }),
                        prompt: e.target.value,
                      },
                    }));
                  }}
                  rows={6}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm resize-none overflow-hidden"
                  placeholder={DEFAULT_INVESTOR_NEWS_PROMPT}
                />
                <p className="mt-2 text-xs text-gray-500">
                  This system prompt instructs the model how to summarize investor news. The query (investor name, firm, type) is generated automatically.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* B2B News Tab */}
      {activeTab === 'b2bNews' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">B2B News Email Opener</h2>
            <p className="text-sm text-gray-500 mb-4">
              Edit the system prompt used to generate a first line and subject line from a piece of company news.
            </p>

            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-gray-800 mb-2">News Email Opener System Prompt</h3>
                <textarea
                  ref={b2bNewsRef}
                  value={formData.b2bNews?.prompt ?? ''}
                  onChange={(e) => {
                    autoGrow(e.currentTarget);
                    setFormData((prev) => ({
                      ...prev,
                      b2bNews: {
                        ...(prev?.b2bNews ?? { prompt: DEFAULT_B2B_NEWS_PROMPT }),
                        prompt: e.target.value,
                      },
                    }));
                  }}
                  rows={6}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm resize-none overflow-hidden"
                  placeholder={DEFAULT_B2B_NEWS_PROMPT}
                />
                <p className="mt-2 text-xs text-gray-500">
                  This prompt must instruct the model to reply as JSON with keys {"{"}first_line_to_start_email{"}"} and {"{"}subject_line{"}"}.
                  Available variables: {"{{"}Company{"}}"}, {"{{"}CompanyName{"}}"}, {"{{"}Url{"}}"}, {"{{"}Domain{"}}"}.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* B2B Ads Tab */}
      {activeTab === 'b2bAds' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">B2B Ads Email Opener</h2>
            <p className="text-sm text-gray-500 mb-4">
              Edit the system prompt used to generate a first line and subject line from a company&apos;s ad copy or campaign.
            </p>

            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-gray-800 mb-2">Ads Email Opener System Prompt</h3>
                <textarea
                  ref={b2bAdsRef}
                  value={formData.b2bAds?.prompt ?? ''}
                  onChange={(e) => {
                    autoGrow(e.currentTarget);
                    setFormData((prev) => ({
                      ...prev,
                      b2bAds: {
                        ...(prev?.b2bAds ?? { prompt: DEFAULT_B2B_ADS_PROMPT }),
                        prompt: e.target.value,
                      },
                    }));
                  }}
                  rows={6}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm resize-none overflow-hidden"
                  placeholder={DEFAULT_B2B_ADS_PROMPT}
                />
                <p className="mt-2 text-xs text-gray-500">
                  This prompt must instruct the model to reply as JSON with keys {"{"}first_line_to_start_email{"}"} and {"{"}subject_line{"}"}.
                  Available variables: {"{{"}Company{"}}"}, {"{{"}CompanyName{"}}"}, {"{{"}Url{"}}"}, {"{{"}Domain{"}}"}.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Jobs Research Tab */}
      {activeTab === 'jobsResearch' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Jobs Research Query</h2>
            <p className="text-sm text-gray-500 mb-4">
              Instruction sent to Exa to evaluate a job posting URL. Used by the Jobs Research mode on the home page.
            </p>
            <textarea
              value={formData.jobsResearch.query}
              onChange={(e) => setFormData({
                ...formData,
                jobsResearch: { ...formData.jobsResearch, query: e.target.value },
              })}
              rows={6}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm"
              placeholder={DEFAULT_JOBS_RESEARCH_QUERY}
            />
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Schema (JSON)</h2>
            <textarea
              value={formData.jobsResearch.schema}
              onChange={(e) => {
                const newSchema = e.target.value;
                setFormData({
                  ...formData,
                  jobsResearch: { ...formData.jobsResearch, schema: newSchema },
                });
                if (newSchema.trim()) {
                  validateSchema(newSchema);
                } else {
                  setSchemaError(null);
                }
              }}
              onBlur={() => {
                if (formData.jobsResearch.schema.trim()) {
                  validateSchema(formData.jobsResearch.schema);
                }
              }}
              rows={30}
              className={`block w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm ${
                schemaError ? 'border-red-300 focus:border-red-500 focus:ring-red-500' : 'border-gray-300'
              }`}
              placeholder="Enter your JSON schema..."
            />
            {schemaError && (
              <p className="mt-2 text-sm text-red-600 bg-red-50 p-2 rounded">
                {schemaError}
              </p>
            )}
            {!schemaError && formData.jobsResearch.schema.trim() && (
              <p className="mt-2 text-sm text-green-600 bg-green-50 p-2 rounded">
                ✓ Valid JSON schema
              </p>
            )}
            <p className="mt-2 text-xs text-gray-500">
              The schema must be valid JSON. Defines the structured fields Exa will extract from the job posting.
            </p>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      <Toast
        message={toastMessage}
        isVisible={showToast}
        onClose={() => setShowToast(false)}
        duration={4000}
      />
    </div>
  );
}
