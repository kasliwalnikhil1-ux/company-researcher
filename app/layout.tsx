import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Analytics } from '@vercel/analytics/next';
import { AuthProvider } from '@/contexts/AuthContext';
import { MessageTemplatesProvider } from '@/contexts/MessageTemplatesContext';
import { CompaniesProvider } from '@/contexts/CompaniesContext';
import { InvestorsProvider } from '@/contexts/InvestorsContext';
import { OwnerProvider } from '@/contexts/OwnerContext';
import { CountryProvider } from '@/contexts/CountryContext';
import { OnboardingProvider } from '@/contexts/OnboardingContext';

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

const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.capitalxai.com';

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: "CapitalxAI CRM",
  description: "Instantly get detailed research insights and know everything about any company inside out.",
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    url: appUrl,
    title: 'CapitalxAI CRM',
    description: 'Instantly get detailed research insights and know everything about any company inside out.',
    images: ['/Open%20Graph%20CapitalxAI.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CapitalxAI CRM',
    description: 'Instantly get detailed research insights and know everything about any company inside out.',
    images: ['/Twitter%20Banner%20CapitalxAI.png'],
  },
};

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
                    <InvestorsProvider>
                      {children}
                      <Analytics />
                    </InvestorsProvider>
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