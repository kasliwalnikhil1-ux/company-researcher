// Brand the MCP connectors belong to: where their links point and on which web app the OAuth sign-in / consent opens.
// Mirrors the per-domain settings of the web app in lib/whitelabel.ts — keep the two in sync.
//
// Each connector is fixed to one brand:
//   capitalxai-mcp (investors)           -> CAPITALXAI
//   crm-mcp, outreach-mcp, smartlead-mcp -> GROWTHXAI

export interface Brand {
  /** Path segment of the brand's authorization server in oauth-as (/oauth-as/<key>). */
  key: "capitalxai" | "growthxai";
  /** Web app origin: links back into the app, and where sign-in / consent opens (no trailing slash). */
  appOrigin: string;
  logoUrl: string;
}

export const CAPITALXAI: Brand = {
  key: "capitalxai",
  appOrigin: "https://app.capitalxai.com",
  logoUrl: "https://app.capitalxai.com/logo.png",
};

export const GROWTHXAI: Brand = {
  key: "growthxai",
  appOrigin: "https://app.growthxai.com",
  logoUrl: "https://app.growthxai.com/logo.png",
};

export const BRANDS: Record<Brand["key"], Brand> = { capitalxai: CAPITALXAI, growthxai: GROWTHXAI };

/** The brand's authorization server (functions/oauth-as): Supabase Auth, with consent opening on the brand's app. */
export function brandAuthServer(brand: Brand): string {
  return `${Deno.env.get("SUPABASE_URL")}/functions/v1/oauth-as/${brand.key}`;
}
