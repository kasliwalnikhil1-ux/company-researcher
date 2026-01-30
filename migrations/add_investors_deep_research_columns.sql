-- Add columns for Investor Deep Research (Steps 2+3)
-- fashion-deep-search + Azure structured extraction

-- Add twitter_url column if not exists
ALTER TABLE investors ADD COLUMN IF NOT EXISTS twitter_url text;

-- Add active column if not exists (bool)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS active boolean;

-- Add email column if not exists (comma-separated values)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS email text;

-- Add notable_investments column if not exists (array of strings in [name](url) format)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS notable_investments text[];

-- Add deep_research column if not exists (raw text from fashion-deep-search)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS deep_research text;

-- Add leads_round column if not exists (bool)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS leads_round boolean;

-- Add research_status column if not exists (to_do for non-investors pending processing)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS research_status text;
