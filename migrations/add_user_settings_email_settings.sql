-- Migration: Add email_settings column to user_settings
-- Stores provider (gmail | outlook) and signature for compose links.
-- Run this if your user_settings table does not yet have an email_settings column.

-- Add email_settings column as JSONB: { provider: 'gmail' | 'outlook', signature: string }
ALTER TABLE user_settings
ADD COLUMN IF NOT EXISTS email_settings jsonb DEFAULT NULL;

COMMENT ON COLUMN user_settings.email_settings IS 'Email compose settings: { provider: "gmail" | "outlook", signature: string }';
