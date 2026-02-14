import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Analytics } from '@vercel/analytics/next';
import { AuthProvider } from '@/contexts/AuthContext';
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
} from '@/lib/whitelabel';

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

export async function generateMetadata(): Promise<Metadata> {
  const headersList = await headers();
  const host = headersList.get('host') ?? undefined;
  const config = getWhitelabelConfig(host);
  // Derive URL from the request host so metadata matches the current environment (dev/prod)
  const protocol = host?.startsWith('localhost') ? 'http' : 'https';
  const appUrl = host ? `${protocol}://${host}` : fallbackAppUrl;

  return {
    metadataBase: new URL(appUrl),
    title: config.pageTitle,
    description: "Instantly get detailed research insights and know everything about any company inside out.",
    icons: {
      icon: [
        { url: getFaviconIcoPath(config), sizes: 'any' },
        { url: getFavicon16Path(config), sizes: '16x16', type: 'image/png' },
        { url: getFavicon32Path(config), sizes: '32x32', type: 'image/png' },
      ],
      apple: getAppleTouchIconPath(config),
    },
    openGraph: {
      url: appUrl,
      title: config.pageTitle,
      description: 'Instantly get detailed research insights and know everything about any company inside out.',
      images: [getOgImagePath(config)],
    },
    twitter: {
      card: 'summary_large_image',
      title: config.pageTitle,
      description: 'Instantly get detailed research insights and know everything about any company inside out.',
      images: [getTwitterImagePath(config)],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${abcdDiatype.variable} ${reckless.variable} antialiased`}
        suppressHydrationWarning
      >
        <AuthProvider>
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
        </AuthProvider>
      </body>
    </html>
  );
}