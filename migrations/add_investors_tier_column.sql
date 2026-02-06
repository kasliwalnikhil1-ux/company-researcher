-- Add tier column for investor grading (A, B, or C)
-- Based on how popular, reputable, helpful, strong network, and founder-friendly they are

ALTER TABLE investors ADD COLUMN IF NOT EXISTS tier text;

-- Add check constraint to ensure only valid tier values
ALTER TABLE investors ADD CONSTRAINT investors_tier_check CHECK (tier IS NULL OR tier IN ('A', 'B', 'C'));
