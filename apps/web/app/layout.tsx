import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/lib/auth/AuthContext';
import { AppLockGate } from '@/lib/applock/AppLockGate';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Pookie Chat',
  description: 'Private, end-to-end encrypted, one-to-one messaging.',
};

// Force dynamic rendering on all pages to ensure fresh per-request CSP nonces
// are generated and applied to all Next.js scripts and styles.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <body className={`${inter.variable} antialiased`}>
        <AuthProvider>
          <AppLockGate>{children}</AppLockGate>
        </AuthProvider>
      </body>
    </html>
  );
}
