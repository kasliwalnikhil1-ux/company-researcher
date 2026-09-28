import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Analytics } from '@vercel/analytics/next';
import { AuthProvider } from '@/contexts/AuthContext';
import { AccessProvider } from '@/contexts/AccessContext';
import { MessageTemplatesProvider } from '@/contexts/MessageTemplatesContext';
import { CompaniesProvider } from '@/contexts/CompaniesContext';
import { OwnerProvider } from '@/contexts/OwnerContext';
import { CountryProvider } from '@/contexts/CountryContext';
import { OnboardingProvider } from '@/contexts/OnboardingContext';
import { PricingModalProvider } from '@/contexts/PricingModalContext';
import { headers } from 'next/headers';
import {
  getWhitelabelConfig,
  getFaviconIcoPath,
  getFavicon16Path,
  getFavicon32Path,
  getAppleTouchIconPath,
  getOgImagePath,
  getTwitterImagePath,
  getOgTitle,
  getOgDescription,
  getOgLogoPath,
} from '@/lib/whitelabel';
import { WhitelabelProvider } from '@/contexts/WhitelabelContext';

// Branding and link-preview tags depend on the request host, so every page must be rendered per request
// (headers() already opts out of static rendering; this makes it explicit so a shared cached HTML can't
// serve one domain's branding to another). Keep it if headers() is ever removed from this file.
export const dynamic = 'force-dynamic';

// Load the ABCDiatype font (Regular and Bold only)
const abcdDiatype = localFont({
  src: [
    { path: "./fonts/ABCDiatype-Regular.otf", weight: "400" },
    { path: "./fonts/ABCDiatype-Bold.otf", weight: "700" },
  ],
  variable: "--font-abcd-diatype",
});

// Load the Reckless font (Regular and Medium only)
const reckless = localFont({
  src: [
    { path: "./fonts/RecklessTRIAL-Regular.woff2", weight: "400" },
    { path: "./fonts/RecklessTRIAL-Medium.woff2", weight: "500" },
  ],
  variable: "--font-reckless",
});

const fallbackAppUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.capitalxai.com';

// Derive URL from the request host so metadata matches the current environment (dev/prod)
function requestOrigin(host: string | undefined): string {
  if (!host) return fallbackAppUrl;
  const hostname = host.replace(/:\d+$/, '');
  const protocol = hostname === 'localhost' || hostname.endsWith('.localhost') ? 'http' : 'https';
  return `${protocol}://${host}`;
}

export async function generateMetadata(): Promise<Metadata> {
  const headersList = await headers();
  const host = headersList.get('host') ?? undefined;
  const config = getWhitelabelConfig(host);
  const appUrl = requestOrigin(host);
  const ogTitle = getOgTitle(config);
  const ogDescription = getOgDescription(config);

  return {
    metadataBase: new URL(appUrl),
    title: config.pageTitle,
    description: config.metaDescription,
    icons: {
      icon: [
        { url: getFaviconIcoPath(config), sizes: 'any' },
        { url: getFavicon16Path(config), sizes: '16x16', type: 'image/png' },
        { url: getFavicon32Path(config), sizes: '32x32', type: 'image/png' },
      ],
      apple: getAppleTouchIconPath(config),
    },
    openGraph: {
      type: 'website',
      url: config.ogUrl ?? appUrl,
      siteName: config.sidebarTitle,
      title: ogTitle,
      description: ogDescription,
      images: [getOgImagePath(config)],
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle,
      description: ogDescription,
      images: [getTwitterImagePath(config)],
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const headersList = await headers();
  const host = headersList.get('host') ?? undefined;
  const whitelabel = getWhitelabelConfig(host);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* og:logo is not in the Metadata API (nor in the ogp.me spec), but some preview checkers read it */}
        <meta property="og:logo" content={new URL(getOgLogoPath(whitelabel), requestOrigin(host)).toString()} />
      </head>
      <body
        className={`${abcdDiatype.variable} ${reckless.variable} antialiased`}
        suppressHydrationWarning
      >
        <WhitelabelProvider config={whitelabel}>
        <AuthProvider>
          <AccessProvider>
            <OnboardingProvider>
              <CountryProvider>
                <OwnerProvider>
                  <MessageTemplatesProvider>
                    <CompaniesProvider>
                      <PricingModalProvider>
                        {children}
                        <Analytics />
                      </PricingModalProvider>
                    </CompaniesProvider>
                  </MessageTemplatesProvider>
                </OwnerProvider>
              </CountryProvider>
            </OnboardingProvider>
          </AccessProvider>
        </AuthProvider>
        </WhitelabelProvider>
      </body>
    </html>
  );
}