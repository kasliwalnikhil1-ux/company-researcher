/**
 * Whitelabel configuration system.
 *
 * Maps hosting domains to brand-specific text and asset overrides.
 * Any property not provided for a domain falls back to the default (CapitalxAI) values.
 *
 * Usage:
 *   Server components  → getWhitelabelConfig(hostname)  (hostname from headers())
 *   Client components  → useWhitelabel() hook            (config resolved on the server by the root layout,
 *                                                          so the first HTML already carries the right brand)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LegalLink {
  label: string;
  href: string;
}

export interface WhitelabelConfig {
  /** Sidebar title shown in MainLayout */
  sidebarTitle: string;
  /** Title shown on login / signup / reset-password pages (e.g. "CapitalxAI CRM") */
  pageTitle: string;
  /** Company name used in copyright lines */
  companyName: string;
  /** Folder name inside public/ that holds brand assets (logo, favicon, og image).
   *  Leave empty string for the default root-level assets. */
  assetsFolder: string;
  /** Whether to show the "©" copyright symbol on login / signup / reset-password pages */
  showCopyright: boolean;

  // --- Login / signup branding panel -------------------------------------
  /** Headline text before the typed word, e.g. "Research any". "\n" starts a new line. */
  authHeadlineBefore: string;
  /** Words the headline types out on a loop (one word = types and deletes the same word) */
  authHeadlineWords: string[];
  /** Headline line under the typed word, e.g. "inside out." Empty string for none. */
  authHeadlineAfter: string;
  /** Line under the headline, e.g. "Access all investors, …" */
  authTagline: string;
  /** Line under "Create an account" */
  signupSubtitle: string;
  /** Pill above the signup form */
  signupBadge: string;
  /** Links in the "you agree to our …" line under the login / signup forms */
  legalLinks: LegalLink[];

  // --- Page metadata / link previews (https://ogp.me) --------------------
  /** <meta name="description"> and the default og:description */
  metaDescription: string;
  /** og:title / twitter:title. Defaults to pageTitle. */
  ogTitle?: string;
  /** og:description / twitter:description. Defaults to metaDescription. */
  ogDescription?: string;
  /** og:image, absolute URL or path under public/. Defaults to <assetsFolder>/og-image.png. */
  ogImage?: string;
  /** twitter:image, absolute URL or path under public/. Defaults to <assetsFolder>/twitter-banner.png. */
  twitterImage?: string;
  /** og:logo, absolute URL or path under public/. Defaults to the logo. */
  ogLogo?: string;
  /** og:url. Defaults to the origin of the current request (so previews and local dev stay correct). */
  ogUrl?: string;
}

// ---------------------------------------------------------------------------
// Default configuration (CapitalxAI – the original branding)
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: WhitelabelConfig = {
  sidebarTitle: 'CapitalxAI',
  pageTitle: 'CapitalxAI CRM',
  companyName: 'ResourcePlan Solution Private Limited',
  assetsFolder: '', // assets live at public/ root
  showCopyright: true,

  authHeadlineBefore: 'Research any',
  authHeadlineWords: ['investor', 'company', 'person', 'prospect'],
  authHeadlineAfter: 'inside out.',
  authTagline: 'Access all investors, expand your reach, and accelerate your fundraising.',
  signupSubtitle: 'Start researching companies with confidence.',
  signupBadge: 'Sign up for your free trial',
  legalLinks: [
    { label: 'Terms', href: 'https://capitalxai.com/terms' },
    { label: 'Content Safety', href: 'https://capitalxai.com/content-safety' },
    { label: 'Privacy Policy', href: 'https://capitalxai.com/privacy' },
  ],

  metaDescription: 'Instantly get detailed research insights and know everything about any company inside out.',
};

// ---------------------------------------------------------------------------
// Domain → config map
// Add new whitelabel entries here.
// ---------------------------------------------------------------------------

const GROWTHXAI: Partial<WhitelabelConfig> = {
  sidebarTitle: 'GrowthxAI',
  pageTitle: 'GrowthxAI Outreach',
  companyName: 'ResourcePlan Solution Private Limited',
  assetsFolder: '', // same logo and favicons as CapitalxAI; only the link-preview images differ
  ogImage: '/growthxai/og-image.png',
  twitterImage: '/growthxai/twitter-banner.png',

  authHeadlineBefore: 'B2B outreach.\nAs easy as',
  authHeadlineWords: ['typing.'],
  authHeadlineAfter: '',
  authTagline: 'More meetings from LinkedIn and email, safely.',
  signupSubtitle: 'Automated LinkedIn and email outreach that books meetings for you.',
  legalLinks: [
    { label: 'Terms', href: 'https://growthxai.com/legal/terms/' },
    { label: 'Acceptable Use', href: 'https://growthxai.com/legal/acceptable-use/' },
    { label: 'Privacy Policy', href: 'https://growthxai.com/legal/privacy/' },
  ],

  metaDescription:
    'Automated LinkedIn and email outreach that books meetings for you, from one account or fifty. Safe limits on every account, and it stops the moment someone replies.',
  ogTitle: 'GrowthxAI Outreach',
};

const WHITELABEL_CONFIGS: Record<string, Partial<WhitelabelConfig>> = {
  'growthxai.com': GROWTHXAI,
  // Local preview: http://growthxai.localhost:3000 (browsers resolve *.localhost to this machine)
  'growthxai.localhost': GROWTHXAI,
  'localhost12': {
    ...GROWTHXAI,
    assetsFolder: 'localhost',
    showCopyright: false,
  },
};

// ---------------------------------------------------------------------------
// Resolve config for a given hostname
// ---------------------------------------------------------------------------

/**
 * Return the full whitelabel config for the supplied hostname.
 * Checks exact match first, then checks if the hostname is a subdomain of a
 * configured domain (e.g. "app.growthxai.com" matches "growthxai.com").
 * Falls back to DEFAULT_CONFIG for any unrecognised domain / missing fields.
 */
export function getWhitelabelConfig(hostname?: string): WhitelabelConfig {
  if (!hostname) return DEFAULT_CONFIG;

  const host = hostname.toLowerCase().replace(/:\d+$/, ''); // strip port

  // Exact match
  if (WHITELABEL_CONFIGS[host]) {
    return { ...DEFAULT_CONFIG, ...WHITELABEL_CONFIGS[host] };
  }

  // Subdomain match – e.g. app.growthxai.com → growthxai.com
  for (const [domain, overrides] of Object.entries(WHITELABEL_CONFIGS)) {
    if (host.endsWith(`.${domain}`)) {
      return { ...DEFAULT_CONFIG, ...overrides };
    }
  }

  return DEFAULT_CONFIG;
}

// ---------------------------------------------------------------------------
// Asset path helpers – fall back to original root-level assets
// ---------------------------------------------------------------------------

/** Logo image path */
export function getLogoPath(config: WhitelabelConfig): string {
  return config.assetsFolder ? `/${config.assetsFolder}/logo.png` : '/logo.png';
}

/** Favicon .ico path */
export function getFaviconIcoPath(config: WhitelabelConfig): string {
  return config.assetsFolder ? `/${config.assetsFolder}/favicon.ico` : '/favicon.ico';
}

/** Favicon 16×16 PNG */
export function getFavicon16Path(config: WhitelabelConfig): string {
  return config.assetsFolder ? `/${config.assetsFolder}/favicon-16x16.png` : '/favicon-16x16.png';
}

/** Favicon 32×32 PNG */
export function getFavicon32Path(config: WhitelabelConfig): string {
  return config.assetsFolder ? `/${config.assetsFolder}/favicon-32x32.png` : '/favicon-32x32.png';
}

/** Apple touch icon */
export function getAppleTouchIconPath(config: WhitelabelConfig): string {
  return config.assetsFolder ? `/${config.assetsFolder}/apple-touch-icon.png` : '/apple-touch-icon.png';
}

/** Open Graph image path */
export function getOgImagePath(config: WhitelabelConfig): string {
  if (config.ogImage) return config.ogImage;
  return config.assetsFolder
    ? `/${config.assetsFolder}/og-image.png`
    : '/Open%20Graph%20CapitalxAI.png';
}

/** Twitter card image path */
export function getTwitterImagePath(config: WhitelabelConfig): string {
  if (config.twitterImage) return config.twitterImage;
  return config.assetsFolder
    ? `/${config.assetsFolder}/twitter-banner.png`
    : '/Twitter%20Banner%20CapitalxAI.png';
}

/** og:logo */
export function getOgLogoPath(config: WhitelabelConfig): string {
  return config.ogLogo ?? getLogoPath(config);
}

/** og:title / twitter:title */
export function getOgTitle(config: WhitelabelConfig): string {
  return config.ogTitle ?? config.pageTitle;
}

/** og:description / twitter:description */
export function getOgDescription(config: WhitelabelConfig): string {
  return config.ogDescription ?? config.metaDescription;
}
