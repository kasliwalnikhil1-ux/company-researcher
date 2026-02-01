-- Add investor_news jsonb to investor_personalization for latest news (answer, citations, date)
-- Structure: { answer: string, citations: string[] (as [title](url)), date: string (ISO) }
-- If using search_investors RPC, add investor_news to the SELECT from investor_personalization join.

ALTER TABLE investor_personalization ADD COLUMN IF NOT EXISTS investor_news jsonb;
