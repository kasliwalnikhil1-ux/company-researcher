// The price book bound to the rules. Edge functions import from here; the web app has the same binding in lib/outreach/pricing.ts.
import { makePricing } from "./pricing_core.ts";
import { PRICE_BOOK } from "./pricing.gen.ts";

export const pricing = makePricing(PRICE_BOOK);
export { PRICE_BOOK };
export { discountedCents, formatUsd } from "./pricing_core.ts";
export type { AccountQuote, BillingPeriod, BillingState, ChangeSplit, PlanId, PriceBook } from "./pricing_core.ts";
