/**
 * Default prompt configuration for Jobs Research.
 *
 * Used as a fallback when `user_settings.personalization.jobsResearch`
 * has no override.
 */
export const DEFAULT_JOBS_RESEARCH_QUERY =
  'Your goal is to determine whether the job application is a good fit for a B2B GTM or ABM expert, and capture the key signals in a strict JSON output.';

export const DEFAULT_JOBS_RESEARCH_SCHEMA = {
  description: 'Schema for extracting job posting information',
  type: 'object',
  required: [
    'job_title',
    'company_name',
    'company_website',
    'company_description',
    'company_customers',
    'compensation_type',
    'compensation_amount',
    'job_application_fit',
  ],
  additionalProperties: false,
  properties: {
    job_title: {
      type: 'string',
      description: 'Title of the job posting',
    },
    company_name: {
      type: 'string',
      description: 'Name of the hiring company without Inc, Pvt Limited, trademark, etc.',
    },
    company_website: {
      type: 'string',
      description: 'Official domain of the company, not LinkedIn company url',
    },
    company_description: {
      type: 'string',
      description: 'Description of the company of what it does',
    },
    company_customers: {
      type: 'string',
      description: 'Type of customers the company serves',
    },
    compensation_type: {
      type: 'string',
      enum: ['fixed', 'commission_only', 'both'],
      description: 'Type of compensation offered',
    },
    compensation_amount: {
      type: 'string',
      description: 'Compensation details as written in the job posting',
    },
    job_application_fit: {
      type: 'boolean',
    },
  },
};

export const DEFAULT_JOBS_RESEARCH_SCHEMA_JSON = JSON.stringify(
  DEFAULT_JOBS_RESEARCH_SCHEMA,
  null,
  2,
);
