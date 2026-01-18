import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Analytics } from '@vercel/analytics/next';
import { AuthProvider } from '@/contexts/AuthContext';
import { MessageTemplatesProvider } from '@/contexts/MessageTemplatesContext';
import { CompaniesProvider } from '@/contexts/CompaniesContext';

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

export const metadata: Metadata = {
  title: "Kaptured.AI CRM",
  description: "Instantly get detailed research insights and know everything about any company inside out.",
  openGraph: {
    title: 'Kaptured.AI CRM',
    description: 'Instantly get detailed research insights and know everything about any company inside out.',
    images: ['https://companyresearcher.exa.ai/opengraph-image.jpg'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Kaptured.AI CRM',
    description: 'Instantly get detailed research insights and know everything about any company inside out.',
    images: ['https://companyresearcher.exa.ai/opengraph-image.jpg'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${abcdDiatype.variable} ${reckless.variable} antialiased`}
        suppressHydrationWarning
      >
        <AuthProvider>
          <MessageTemplatesProvider>
            <CompaniesProvider>
              {children}
              <Analytics />
            </CompaniesProvider>
          </MessageTemplatesProvider>
        </AuthProvider>
      </body>
    </html>
  );
}