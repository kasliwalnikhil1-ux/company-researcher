/**
 * Whitelabel configuration system.
 *
 * Maps hosting domains to brand-specific text and asset overrides.
 * Any property not provided for a domain falls back to the default (CapitalxAI) values.
 *
 * Usage:
 *   Server components  → getWhitelabelConfig(hostname)  (hostname from headers())
 *   Client components  → useWhitelabel() hook            (reads window.location.hostname)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
};

// ---------------------------------------------------------------------------
// Domain → config map
// Add new whitelabel entries here.
// ---------------------------------------------------------------------------

const WHITELABEL_CONFIGS: Record<string, Partial<WhitelabelConfig>> = {
  'growthxai.com': {
    sidebarTitle: 'GrowthxAI',
    pageTitle: 'GrowthxAI CRM',
    companyName: 'Fidelman',
    assetsFolder: 'growthxai',
  },
  'localhost12': {
    sidebarTitle: 'GrowthxAI',
    pageTitle: 'GrowthxAI CRM',
    companyName: 'Fidelman',
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
  return config.assetsFolder
    ? `/${config.assetsFolder}/og-image.png`
    : '/Open%20Graph%20CapitalxAI.png';
}

/** Twitter card image path */
export function getTwitterImagePath(config: WhitelabelConfig): string {
  return config.assetsFolder
    ? `/${config.assetsFolder}/twitter-banner.png`
    : '/Twitter%20Banner%20CapitalxAI.png';
}
