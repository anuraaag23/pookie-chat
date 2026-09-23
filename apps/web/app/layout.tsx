import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '@/lib/theme/ThemeContext';
import { AuthProvider } from '@/lib/auth/AuthContext';
import { AppLockGate } from '@/lib/applock/AppLockGate';
import { AuthGate } from '@/components/auth/AuthGate';
import { OfflineBanner } from '@/components/ui/OfflineBanner';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Pookie Chat',
  description: 'Private, end-to-end encrypted, one-to-one messaging.',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
};

// Force dynamic rendering on all pages to ensure fresh per-request CSP nonces
// are generated and applied to all Next.js scripts and styles.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <body className={`${inter.variable} antialiased`}>
        <ThemeProvider>
          <AuthProvider>
            <OfflineBanner />
            <AppLockGate>
              <AuthGate>{children}</AuthGate>
            </AppLockGate>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
