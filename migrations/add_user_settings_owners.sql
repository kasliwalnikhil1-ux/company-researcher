-- Migration: Add owners column to user_settings
-- Stores owner config (name + colors) per user, same pattern as personalization.
-- Run this if your user_settings table does not yet have an owners column.

-- Add owners column as JSONB (array of { name, colors: { bg, text, border, hex } })
ALTER TABLE user_settings
ADD COLUMN IF NOT EXISTS owners jsonb DEFAULT '[]'::jsonb;

-- Optional: comment for documentation
COMMENT ON COLUMN user_settings.owners IS 'Array of owner config: [{ name: string, colors: { bg, text, border, hex } }]';
