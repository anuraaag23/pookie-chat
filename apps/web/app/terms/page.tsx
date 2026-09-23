import type { Metadata } from 'next';
import Link from 'next/link';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { PublicFooter } from '@/components/ui/PublicFooter';

export const metadata: Metadata = {
  title: 'Pookie Chat — Terms of Service',
  description: 'Review the terms, acceptable use conditions, and legal agreements governing the use of Pookie Chat.',
};

export default function TermsOfServicePage() {
  const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;

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
          <div className="text-xs font-bold uppercase tracking-wider text-ink-dim">Legal Documentation</div>
        </header>

        {/* Main Content Card */}
        <NeoSurface variant="raised" className="p-6 sm:p-10">
          <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Terms of Service</h1>
          <p className="mt-2 text-xs text-ink-dim">
            Effective Date: September 23, 2026 &bull; Version 1.1
          </p>

          <hr className="my-6 border-ink/10" />

          <div className="space-y-8 text-sm leading-relaxed text-ink/90">
            {/* 1. Acceptance */}
            <section>
              <h2 className="text-lg font-bold text-ink">1. Acceptance of Terms</h2>
              <p className="mt-2">
                By accessing or using Pookie Chat (&ldquo;the Service&rdquo;), you agree to be bound by these Terms of Service
                (&ldquo;Terms&rdquo;) and our <Link href="/privacy" className="text-info underline hover:text-info/80">Privacy Policy</Link>.
                If you do not agree to these Terms, you may not access or use the Service.
              </p>
            </section>

            {/* 2. Eligibility */}
            <section>
              <h2 className="text-lg font-bold text-ink">2. Eligibility &amp; Lawful Use</h2>
              <p className="mt-2">
                You must be at least 13 years of age (or the minimum legal age in your jurisdiction) and have the legal capacity
                to enter into binding agreements to use Pookie Chat. You agree to use the Service strictly in accordance with
                all applicable local, national, and international laws and regulations.
              </p>
            </section>

            {/* 3. Account Responsibilities */}
            <section>
              <h2 className="text-lg font-bold text-ink">3. Account Registration &amp; Security</h2>
              <p className="mt-2">
                To access Pookie Chat, you create an account with a unique username, password, and verified email address:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>
                  <strong className="text-ink">Credential Confidentiality:</strong> You are solely responsible for maintaining
                  the confidentiality of your password and safeguarding the physical security of your devices and sessions.
                </li>
                <li>
                  <strong className="text-ink">No Key Escrow:</strong> Because Pookie Chat does not possess your cryptographic
                  private keys or plaintext passwords, we cannot restore access to your message history if you lose access to your
                  credentials or authorized device.
                </li>
                <li>
                  <strong className="text-ink">Unauthorized Access:</strong> You agree to notify us immediately via our{' '}
                  <Link href="/support" className="text-info underline hover:text-info/80">Support Page</Link> if you suspect
                  unauthorized access to your account.
                </li>
              </ul>
            </section>

            {/* 4. Acceptable Use */}
            <section>
              <h2 className="text-lg font-bold text-ink">4. Acceptable Use Policy</h2>
              <p className="mt-2">You agree not to use Pookie Chat to engage in any of the following prohibited activities:</p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>Transmitting unlawful, abusive, harassing, defamatory, threatening, or sexually explicit content involving minors.</li>
                <li>Distributing malware, viruses, trojans, ransomware, or other malicious software code.</li>
                <li>Attempting to probe, scan, or compromise the vulnerability of our servers, networks, or authentication systems.</li>
                <li>Interfering with or disrupting the integrity, performance, or availability of the Service.</li>
                <li>Circumventing API rate limits, brute-force protections, or authentication safeguards.</li>
                <li>Using automated scripts, bots, or scrapers to access the Service without authorization.</li>
                <li>Impersonating another person or misrepresenting your affiliation with any entity.</li>
              </ul>
            </section>

            {/* 5. User Content & Ownership */}
            <section>
              <h2 className="text-lg font-bold text-ink">5. User Content &amp; Intellectual Property Ownership</h2>
              <p className="mt-2">
                <strong className="text-ink">Your Content Belongs to You:</strong> You retain complete ownership and all intellectual
                property rights in and to the messages, files, text, images, and attachments that you send or upload through Pookie Chat.
                Pookie Chat does not claim any ownership rights over your content.
              </p>
              <p className="mt-2">
                Because all message content and attachments are encrypted on your device prior to reaching our servers, you are
                solely responsible for the legality, accuracy, and consequences of the communications you transmit.
              </p>
            </section>

            {/* 6. Encryption Limitations */}
            <section>
              <h2 className="text-lg font-bold text-ink">6. End-to-End Encryption &amp; Security Limitations</h2>
              <p className="mt-2">
                Pookie Chat uses modern client-side encryption protocols to protect your messages and attachments from eavesdroppers
                and server operators. However, you acknowledge and agree that:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>
                  No messaging protocol can prevent a recipient from capturing, copying, photographing, screenshotting, or forwarding
                  messages once decrypted and displayed on their screen.
                </li>
                <li>
                  Client-side security depends directly on the security of the devices you use. Malware, screen-recording tools,
                  or compromised operating systems on either end of a conversation can compromise plaintext content.
                </li>
                <li>
                  Pookie Chat provides message-level forward secrecy using a forward-secret ratchet protocol; it is an evolving
                  secure messaging system and has not been certified by a third-party commercial audit.
                </li>
              </ul>
            </section>

            {/* 7. Google Drive Integration */}
            <section>
              <h2 className="text-lg font-bold text-ink">7. Optional Google Drive Attachment Storage</h2>
              <p className="mt-2">
                Pookie Chat offers an optional feature allowing you to store your encrypted chat attachments in your own Google Drive:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>
                  By connecting Google Drive, you authorize Pookie Chat to create and access files in a dedicated &ldquo;Pookie Chat&rdquo;
                  folder using the <code className="rounded bg-surface-2 px-1 py-0.5 text-xs font-mono">drive.file</code> scope.
                </li>
                <li>
                  Your use of Google Drive is governed by Google&apos;s Terms of Service and Privacy Policy. Pookie Chat is not responsible
                  for Google Drive service outages, storage quotas, rate limits, or account restrictions enforced by Google LLC.
                </li>
                <li>
                  You may disconnect Google Drive at any time in Settings, which ceases future uploads to Google Drive and deletes
                  stored credentials from our database without deleting existing files from your Google Drive.
                </li>
              </ul>
            </section>

            {/* 8. Third-Party Services */}
            <section>
              <h2 className="text-lg font-bold text-ink">8. Third-Party Infrastructure Services</h2>
              <p className="mt-2">
                Pookie Chat relies on trusted third-party cloud infrastructure (such as Vercel, Render, Aiven, and SMTP providers)
                to host the service, manage databases, and relay communications. We are not liable for service interruptions, data loss,
                or downtime caused by third-party hosting or network outages.
              </p>
            </section>

            {/* 9. Service Availability & Modifications */}
            <section>
              <h2 className="text-lg font-bold text-ink">9. Service Availability &amp; Modifications</h2>
              <p className="mt-2">
                We strive to maintain continuous availability of Pookie Chat. However, the Service is provided on an &ldquo;AS IS&rdquo;
                and &ldquo;AS AVAILABLE&rdquo; basis. We reserve the right to modify, suspend, update, or discontinue any aspect of the
                Service at any time, with or without prior notice.
              </p>
            </section>

            {/* 10. Account Suspension & Termination */}
            <section>
              <h2 className="text-lg font-bold text-ink">10. Account Suspension &amp; Termination</h2>
              <p className="mt-2">
                We reserve the right to suspend or terminate your account and access to the Service at our discretion, without prior notice,
                if we determine that you have violated these Terms, engaged in abuse, or posed a security risk to the Service or other users.
              </p>
            </section>

            {/* 11. Account Deletion */}
            <section>
              <h2 className="text-lg font-bold text-ink">11. Account Deletion by User</h2>
              <p className="mt-2">
                You may delete your account at any time by confirming your password. Deleting your account permanently deletes your
                profile, credentials, sessions, pairing relationships, and stored ciphertext messages from the active Pookie Chat database.
                Files previously stored in your personal Google Drive are not deleted by this action and remain in your control.
              </p>
            </section>

            {/* 12. Intellectual Property */}
            <section>
              <h2 className="text-lg font-bold text-ink">12. Pookie Chat Intellectual Property</h2>
              <p className="mt-2">
                All rights, title, and interest in and to the Pookie Chat application, interfaces, design system, trademarks, logo,
                and software code are and remain the exclusive property of Pookie Chat and its licensors.
              </p>
            </section>

            {/* 13. Disclaimer of Warranties */}
            <section>
              <h2 className="text-lg font-bold text-ink">13. Disclaimer of Warranties</h2>
              <p className="mt-2 font-medium uppercase text-xs tracking-wider text-ink-dim">
                Please read this section carefully as it limits our liability.
              </p>
              <p className="mt-2">
                TO THE MAXIMUM EXTENT PERMITTED UNDER APPLICABLE LAW, POOKIE CHAT IS PROVIDED WITHOUT WARRANTIES OF ANY KIND,
                WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY,
                FITNESS FOR A PARTICULAR PURPOSE, TITLE, QUIET ENJOYMENT, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE
                WILL BE UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE OF HARMFUL COMPONENTS.
              </p>
            </section>

            {/* 14. Limitation of Liability */}
            <section>
              <h2 className="text-lg font-bold text-ink">14. Limitation of Liability</h2>
              <p className="mt-2">
                TO THE MAXIMUM EXTENT PERMITTED UNDER APPLICABLE LAW, IN NO EVENT SHALL POOKIE CHAT, ITS OPERATORS, AFFILIATES,
                OR SERVICE PROVIDERS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING
                LOSS OF PROFITS, LOSS OF DATA, LOSS OF GOODWILL, OR SERVICE INTERRUPTION, ARISING OUT OF OR IN CONNECTION WITH YOUR USE
                OR INABILITY TO USE THE SERVICE, REGARDLESS OF THE LEGAL THEORY ADVANCED.
              </p>
            </section>

            {/* 15. Governing Law */}
            <section>
              <h2 className="text-lg font-bold text-ink">15. Governing Law &amp; Dispute Resolution</h2>
              <p className="mt-2">
                These Terms and any dispute arising out of or related to your use of Pookie Chat shall be governed by and construed
                in accordance with the applicable laws of the jurisdiction in which the service operator resides, without regard to
                conflict of law principles.
              </p>
            </section>

            {/* 16. Changes to Terms */}
            <section>
              <h2 className="text-lg font-bold text-ink">16. Changes to Terms</h2>
              <p className="mt-2">
                We may revise these Terms from time to time. The most current version will always be posted on this page with an updated
                Effective Date. By continuing to access or use the Service after revisions become effective, you agree to be bound
                by the revised Terms.
              </p>
            </section>

            {/* 17. Contact */}
            <section>
              <h2 className="text-lg font-bold text-ink">17. Contact Information</h2>
              <p className="mt-2">
                For questions regarding these Terms of Service, please visit our{' '}
                <Link href="/support" className="text-info underline hover:text-info/80">Support Page</Link>
                {supportEmail ? (
                  <> or reach out via email at <a href={`mailto:${supportEmail}`} className="text-info underline hover:text-info/80">{supportEmail}</a></>
                ) : null}.
              </p>
            </section>
          </div>
        </NeoSurface>

        {/* Public Footer */}
        <PublicFooter className="mt-8" />
      </div>
    </div>
  );
}
