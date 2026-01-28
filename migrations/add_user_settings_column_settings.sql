-- Migration: Add column_settings column to user_settings
-- Stores companies table column config: order, visibility, clipboard/subject/compact columns, phone click behavior.
-- Run this if your user_settings table does not yet have a column_settings column.

ALTER TABLE user_settings
ADD COLUMN IF NOT EXISTS column_settings jsonb DEFAULT NULL;

COMMENT ON COLUMN user_settings.column_settings IS 'Companies table: { columnOrder: string[], visibleColumns: string[], clipboardColumn: string | null, subjectColumn: string | null, compactColumn: string | null, phoneClickBehavior: "whatsapp" | "call" }';
