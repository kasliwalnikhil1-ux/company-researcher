-- Add ai_metadata and has_personalization columns for investor AI analysis
-- ai_metadata stores: investor_fit, reason, line1, line2, mutual_interests

ALTER TABLE investors ADD COLUMN IF NOT EXISTS ai_metadata jsonb;
ALTER TABLE investors ADD COLUMN IF NOT EXISTS has_personalization boolean DEFAULT false;

-- RPC: upsert_investor_ai_metadata
-- Merges new_ai_metadata into investor's ai_metadata and sets has_personalization = true
CREATE OR REPLACE FUNCTION upsert_investor_ai_metadata(
  investor_uuid uuid,
  new_ai_metadata jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE investors
  SET
    ai_metadata = COALESCE(ai_metadata, '{}'::jsonb) || new_ai_metadata,
    has_personalization = true
  WHERE id = investor_uuid;
END;
$$;
