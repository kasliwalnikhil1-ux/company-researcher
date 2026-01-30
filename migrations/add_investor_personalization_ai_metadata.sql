-- Add ai_metadata jsonb to investor_personalization for user-editable Personalization (line1, line2) and mutual_interests
-- Stored like notes - per-user overrides/edits to AI-generated content

ALTER TABLE investor_personalization ADD COLUMN IF NOT EXISTS ai_metadata jsonb;
