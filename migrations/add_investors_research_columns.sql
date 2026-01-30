-- Add columns for Investor Research feature
-- domain, linkedin_url, type, links for investor classification

-- Add domain column if not exists
ALTER TABLE investors ADD COLUMN IF NOT EXISTS domain text;

-- Add linkedin_url column if not exists
ALTER TABLE investors ADD COLUMN IF NOT EXISTS linkedin_url text;

-- Add type column if not exists (firm/person)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS type text CHECK (type IN ('firm', 'person'));

-- Add links column if not exists (list of [title](url) strings)
-- Using text[] for array of strings
ALTER TABLE investors ADD COLUMN IF NOT EXISTS links text[];
