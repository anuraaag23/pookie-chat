'use client';

import { useState } from 'react';
import Link from 'next/link';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { Button } from '@/components/ui/Button';
import { PublicFooter } from '@/components/ui/PublicFooter';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

export default function SupportPage() {
  const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@pookie.chat';
  const [copied, setCopied] = useState(false);

  function copyEmail() {
    if (!supportEmail) return;
    navigator.clipboard.writeText(supportEmail).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const helpTopics = [
    {
      title: 'Account & Login Issues',
      icon: (
        <svg className="h-5 w-5 text-info" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      ),
      description: 'Trouble signing in with your username or verified email, session lockouts, or managing connected devices.',
    },
    {
      title: 'Email Verification Assistance',
      icon: (
        <svg className="h-5 w-5 text-info" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      ),
      description: 'Verification code delivery delays, expired codes, resend cooldowns, or email typo corrections during signup.',
    },
    {
      title: 'Google Drive Storage Setup',
      icon: (
        <svg className="h-5 w-5 text-info" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
      ),
      description: 'Connecting personal Google Drive storage, folder permissions, token refresh, or disconnecting storage.',
    },
    {
      title: 'Encrypted Attachments & Media',
      icon: (
        <svg className="h-5 w-5 text-info" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
        </svg>
      ),
      description: 'Troubleshooting client-side attachment encryption, file size boundaries (up to 25MB), or download errors.',
    },
    {
      title: 'Security Concerns & Vulnerabilities',
      icon: (
        <svg className="h-5 w-5 text-info" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      ),
      description: 'Responsible disclosure of security vulnerabilities, suspicious activity, or privacy policy inquiries.',
    },
    {
      title: 'Account Deletion & Data Rights',
      icon: (
        <svg className="h-5 w-5 text-info" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      ),
      description: 'Assistance with permanent account removal, cascading server data purging, or privacy rights inquiries.',
    },
  ];

  return (
    <div className="min-h-screen bg-surface px-4 py-8 text-ink sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        {/* Navigation Bar */}
        <header className="mb-6 flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-xs font-semibold text-ink-dim transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-2"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back to Pookie Chat
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-xs font-bold uppercase tracking-wider text-ink-dim">Help &amp; Support</span>
            <ThemeToggle />
          </div>
        </header>

        {/* Hero Card */}
        <NeoSurface variant="raised" className="p-6 sm:p-10">
          <div className="text-center sm:text-left">
            <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Pookie Chat Support</h1>
            <p className="mt-2 text-sm text-ink-dim">
              We&apos;re here to help you resolve technical questions, connection issues, and account inquiries.
            </p>
          </div>

          <hr className="my-6 border-ink/10" />

          {/* Contact Methods Section */}
          <div className="mb-8">
            <h2 className="text-sm font-bold uppercase tracking-wider text-ink-dim">Contact Support</h2>
            <NeoSurface variant="pressed" className="mt-3 flex flex-col items-start justify-between gap-4 p-5 sm:flex-row sm:items-center">
              <div>
                <div className="text-xs font-medium text-ink-dim">Official Support Email</div>
                <a
                  href={`mailto:${encodeURIComponent(supportEmail)}?subject=${encodeURIComponent('Pookie Chat Support Request')}`}
                  className="mt-0.5 block text-base font-semibold text-info hover:underline"
                >
                  {supportEmail}
                </a>
                <p className="mt-1 text-xs text-ink-dim">
                  Expect a response within 24 to 48 business hours.
                </p>
              </div>
              <div className="flex items-center gap-2.5 w-full sm:w-auto">
                <a
                  href={`mailto:${encodeURIComponent(supportEmail)}?subject=${encodeURIComponent('Pookie Chat Support Request')}&body=${encodeURIComponent('Hello Pookie Chat Support team,\n\n[Please describe your issue or question here]\n\n')}`}
                  className="neo-raised active:neo-pressed bg-surface hover:opacity-95 text-info font-semibold text-xs px-4 py-2.5 rounded-lg border border-glass-border/40 flex-1 sm:flex-none flex items-center justify-center gap-2 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
                  aria-label="Send Email to Support"
                >
                  <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                    <polyline points="22,6 12,13 2,6" />
                  </svg>
                  <span>Send Email</span>
                </a>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={copyEmail}
                  className="text-xs px-3 py-2.5 flex items-center justify-center gap-1.5"
                  aria-label="Copy support email address"
                >
                  {copied ? (
                    <>
                      <svg className="w-3.5 h-3.5 text-positive shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      <span className="text-positive font-bold">Copied!</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5 text-ink-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      <span>Copy</span>
                    </>
                  )}
                </Button>
              </div>
            </NeoSurface>
          </div>

          {/* Topics Grid */}
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-ink-dim">What We Can Help With</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {helpTopics.map((topic) => (
              <NeoSurface key={topic.title} variant="pressed" className="p-4">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface neo-raised">
                    {topic.icon}
                  </span>
                  <h3 className="text-xs font-bold text-ink">{topic.title}</h3>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-ink-dim">
                  {topic.description}
                </p>
              </NeoSurface>
            ))}
          </div>

          {/* FAQ Card */}
          <div className="mt-8 rounded-lg bg-surface-2 p-4 text-xs text-ink-dim">
            <strong className="text-ink">Lost Encryption Keys?</strong> Because Pookie Chat does not store your private keys
            or escrow recovery phrases on servers, our support team cannot recover chat history if you lose access to your authorized
            device. This is an intentional security design ensuring that no one&mdash;not even our staff&mdash;can read your private communications.
          </div>
        </NeoSurface>

        {/* Public Footer */}
        <PublicFooter className="mt-8" />
      </div>
    </div>
  );
}
