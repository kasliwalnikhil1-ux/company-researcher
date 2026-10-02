// The price book bound to the rules, for the web app. The rules live in one file shared with the edge functions
// (supabase/functions/_shared/outreach/pricing_core.ts); the numbers live in pricing/v1.json (pricing-billing-PRD §11.4).
import book from '../../pricing/v1.json';
import { makePricing, type PriceBook } from '../../supabase/functions/_shared/outreach/pricing_core';

export const PRICE_BOOK = book as PriceBook;
export const pricing = makePricing(PRICE_BOOK);
export { discountedCents, formatUsd } from '../../supabase/functions/_shared/outreach/pricing_core';
export type { AccountQuote, BillingPeriod, BillingState, ChangeSplit, PlanId, PriceBook } from '../../supabase/functions/_shared/outreach/pricing_core';
