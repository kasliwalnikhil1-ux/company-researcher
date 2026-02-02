-- Add person-only columns for work experience and education orgs (format [name](url) like coinvestors)

ALTER TABLE investors ADD COLUMN IF NOT EXISTS work_experience_orgs text[];
ALTER TABLE investors ADD COLUMN IF NOT EXISTS education_orgs text[];
