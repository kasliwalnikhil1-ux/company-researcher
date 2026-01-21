'use client';

import { useState, useEffect } from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import MainLayout from '@/components/MainLayout';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/utils/supabase/client';
import Toast from '@/components/ui/Toast';

export default function PersonalizationPage() {
  return (
    <ProtectedRoute>
      <MainLayout>
        <div className="flex-1 overflow-auto">
          <PersonalizationContent />
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
}

function PersonalizationContent() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'direct' | 'instagram'>('direct');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);
  const [formData, setFormData] = useState<PersonalizationData>({
    direct: {
      query: '',
      schema: '',
    },
    instagram: {
      systemPrompt: '',
      userMessage: '',
    },
  });

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
          const defaultData = {
            direct: {
              query: defaultDirectQuery,
              schema: defaultDirectSchema,
            },
            instagram: {
              systemPrompt: defaultInstagramSystemPrompt,
              userMessage: defaultInstagramUserMessage,
            },
          };
          setFormData(defaultData);
          // Validate default schema
          if (defaultData.direct.schema) {
            validateSchema(defaultData.direct.schema);
          }
        } else if (error) {
          // Other error occurred
          console.error('Error fetching personalization:', error);
          // Use defaults on error
          setFormData({
            direct: {
              query: defaultDirectQuery,
              schema: defaultDirectSchema,
            },
            instagram: {
              systemPrompt: defaultInstagramSystemPrompt,
              userMessage: defaultInstagramUserMessage,
            },
          });
        } else if (data?.personalization) {
          // Personalization exists, load it
          const parsed = typeof data.personalization === 'string' 
            ? JSON.parse(data.personalization) 
            : data.personalization;
          
          const loadedData = {
            direct: {
              query: parsed.direct?.query || defaultDirectQuery,
              schema: parsed.direct?.schema || defaultDirectSchema,
            },
            instagram: {
              systemPrompt: parsed.instagram?.systemPrompt || defaultInstagramSystemPrompt,
              userMessage: parsed.instagram?.userMessage || defaultInstagramUserMessage,
            },
          };
          
          setFormData(loadedData);
          
          // Validate schema if it exists
          if (loadedData.direct.schema) {
            validateSchema(loadedData.direct.schema);
          }
        } else {
          // No personalization data, use defaults
          setFormData({
            direct: {
              query: defaultDirectQuery,
              schema: defaultDirectSchema,
            },
            instagram: {
              systemPrompt: defaultInstagramSystemPrompt,
              userMessage: defaultInstagramUserMessage,
            },
          });
        }
      } catch (error) {
        console.error('Error in fetchPersonalization:', error);
        // Use defaults on error
        setFormData({
          direct: {
            query: defaultDirectQuery,
            schema: defaultDirectSchema,
          },
          instagram: {
            systemPrompt: defaultInstagramSystemPrompt,
            userMessage: defaultInstagramUserMessage,
          },
        });
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

      const personalizationData = {
        direct: {
          query: formData.direct.query,
          schema: formData.direct.schema,
        },
        instagram: {
          systemPrompt: formData.instagram.systemPrompt,
          userMessage: formData.instagram.userMessage,
        },
      };

      // Upsert user settings
      const { error } = await supabase
        .from('user_settings')
        .upsert({
          id: user.id,
          personalization: personalizationData,
        }, {
          onConflict: 'id'
        });

      if (error) {
        console.error('Error saving personalization:', error);
        throw new Error(error.message || 'Failed to save personalization settings');
      }

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

  const handleReset = () => {
    if (confirm('Are you sure you want to reset to default values? This will overwrite your current settings.')) {
      setFormData({
        direct: {
          query: defaultDirectQuery,
          schema: defaultDirectSchema,
        },
        instagram: {
          systemPrompt: defaultInstagramSystemPrompt,
          userMessage: defaultInstagramUserMessage,
        },
      });
    }
  };

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
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
            onClick={handleReset}
            className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
          >
            Reset to Defaults
          </button>
          <button
            onClick={handleSave}
            disabled={saving || (activeTab === 'direct' && schemaError !== null)}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
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
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'direct'
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Direct
          </button>
          <button
            onClick={() => {
              setActiveTab('instagram');
              // Clear schema error when switching away from direct tab
              setSchemaError(null);
            }}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'instagram'
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Instagram
          </button>
        </nav>
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
