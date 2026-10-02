import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '@/lib/theme/ThemeContext';
import { AuthProvider } from '@/lib/auth/AuthContext';
import { AppLockGate } from '@/lib/applock/AppLockGate';
import { AuthGate } from '@/components/auth/AuthGate';
import { CaptureProtection } from '@/lib/security/CaptureProtection';
import { OfflineBanner } from '@/components/ui/OfflineBanner';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: 'resizes-content',
};

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
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('pookie_theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme:dark)').matches)){document.documentElement.setAttribute('data-theme','dark');}else{document.documentElement.setAttribute('data-theme','light');}var a=localStorage.getItem('pookie_accent');if(a){document.documentElement.style.setProperty('--blue',a);}}catch(e){}})()`,
          }}
        />
      </head>
      <body className={`${inter.variable} antialiased bg-surface text-ink transition-colors duration-150`}>
        <ThemeProvider>
          <AuthProvider>
            <OfflineBanner />
            <AppLockGate>
              <AuthGate>
                <CaptureProtection>{children}</CaptureProtection>
              </AuthGate>
            </AppLockGate>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
