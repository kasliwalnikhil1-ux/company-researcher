declare module 'iso-3166-2' {
  interface SubdivisionResult {
    type: string;
    name: string;
    countryName?: string;
    countryCode?: string;
    regionCode?: string;
    code?: string;
  }

  interface Iso3166 {
    subdivision(code: string): SubdivisionResult | null;
    subdivision(countryCode: string, subdivisionCode: string): SubdivisionResult | null;
    subdivision(countryCode: string, subdivisionName: string): SubdivisionResult | null;
    country(codeOrName: string): { name: string; sub: Record<string, { type: string; name: string }>; code: string } | null;
    data: Record<string, unknown>;
    codes: Record<string, string>;
  }

  const iso3166: Iso3166;
  export default iso3166;
}
