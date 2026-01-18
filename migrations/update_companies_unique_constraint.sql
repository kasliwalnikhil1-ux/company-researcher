-- Migration: Update companies table unique constraint
-- Change from single domain unique constraint to composite (domain, instagram) unique constraint

-- Step 1: Drop the existing unique constraint on domain only
DROP INDEX IF EXISTS idx_companies_domain;

-- Step 2: Create a new unique constraint on (domain, instagram) combination
-- This allows the same domain with different instagram values, and same instagram with different domains
-- But prevents duplicate combinations of domain + instagram
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_domain_instagram ON companies(user_id, domain, instagram);

-- Note: The constraint includes user_id to ensure uniqueness is per user
-- This means different users can have the same domain+instagram combination
-- If you want global uniqueness (across all users), remove user_id from the index
