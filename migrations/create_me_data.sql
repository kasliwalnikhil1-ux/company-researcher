-- Migration: Create me_data table
-- Stores ME data entries with type and jsonb data.

CREATE TABLE IF NOT EXISTS me_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  type text,
  data jsonb,
  created_at timestamptz DEFAULT now()
);

-- RLS: users can only access their own rows
ALTER TABLE me_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own me_data"
  ON me_data FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own me_data"
  ON me_data FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own me_data"
  ON me_data FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own me_data"
  ON me_data FOR DELETE
  USING (auth.uid() = user_id);
