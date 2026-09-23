import type { Metadata } from 'next';
import Link from 'next/link';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { PublicFooter } from '@/components/ui/PublicFooter';

export const metadata: Metadata = {
  title: 'Pookie Chat — Privacy Policy',
  description: 'Understand how Pookie Chat protects your privacy, handles client-side encryption, and manages data.',
};

export default function PrivacyPolicyPage() {
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
          <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Privacy Policy</h1>
          <p className="mt-2 text-xs text-ink-dim">
            Effective Date: September 23, 2026 &bull; Version 1.1
          </p>

          <hr className="my-6 border-ink/10" />

          <div className="space-y-8 text-sm leading-relaxed text-ink/90">
            {/* Section 1: Introduction */}
            <section>
              <h2 className="text-lg font-bold text-ink">1. Introduction</h2>
              <p className="mt-2">
                Pookie Chat (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) is a private, one-to-one web messaging service
                designed to minimize central data possession through client-side encryption and minimal data architecture.
                This Privacy Policy explains what information is processed when you use Pookie Chat, how that information
                is handled, and your choices regarding your personal data.
              </p>
              <p className="mt-2">
                If you have questions or concerns about this policy or your data, you can reach our support team through
                our <Link href="/support" className="text-info underline hover:text-info/80">Support Page</Link>
                {supportEmail ? (
                  <> or via email at <a href={`mailto:${supportEmail}`} className="text-info underline hover:text-info/80">{supportEmail}</a></>
                ) : null}.
              </p>
            </section>

            {/* Section 2: Information Handled */}
            <section>
              <h2 className="text-lg font-bold text-ink">2. Information Handled by Pookie Chat</h2>
              <p className="mt-2">
                We collect and process only the minimal information required to deliver, secure, and operate the service.
                Categories of information processed include:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>
                  <strong className="text-ink">Account Credentials &amp; Identity:</strong> When you register, you choose a unique username
                  and password, and provide an email address. Passwords are never stored or seen in plaintext; they are hashed
                  server-side using Scrypt with a secure server pepper and timing-safe evaluation. Each account is assigned an internal,
                  immutable Account UUID for system indexing.
                </li>
                <li>
                  <strong className="text-ink">Email Verification Data:</strong> For email-based registration, the system creates a
                  temporary, cryptographically random 6-digit verification code. The code is stored solely as a SHA-256 hash
                  with a 15-minute expiration timestamp and an attempt counter. It is consumed and invalidated upon verification.
                  Pre-existing legacy accounts created prior to email identity may have no email associated with their account.
                </li>
                <li>
                  <strong className="text-ink">Device &amp; Session Metadata:</strong> To route notifications and support multiple active
                  browser sessions, our servers store device records containing a random device ID, client platform (e.g., Web),
                  user-agent header, IP address (recorded strictly in security logs for unauthorized login alerts), and timestamps
                  of session creation and last activity.
                </li>
                <li>
                  <strong className="text-ink">Encrypted Messages:</strong> All message text is encrypted on your device prior to
                  transmission. The server acts as an encrypted relay and queue: it stores only ciphertext blobs and essential routing
                  metadata (sender ID, recipient ID, conversation ID, message timestamp, delivery state, and session isolation epoch).
                  Our servers do not hold the decryption keys required to read your messages.
                </li>
                <li>
                  <strong className="text-ink">Encrypted Attachments:</strong> Files and images shared in chats are encrypted on your
                  device using symmetric AES-256-GCM encryption with a unique per-file key. The server stores only the opaque encrypted
                  bytes and an encrypted data encryption key (DEK) decryptable solely by conversation participants.
                </li>
                <li>
                  <strong className="text-ink">Google Drive OAuth Information (Voluntary):</strong> If you elect to use the optional
                  user-owned Google Drive storage feature, our backend stores your Google account subject ID, optional Google email,
                  the ID of the dedicated &ldquo;Pookie Chat&rdquo; Drive folder, and your OAuth access and refresh tokens. All OAuth tokens
                  are encrypted at rest using AES-256-GCM before storage.
                </li>
                <li>
                  <strong className="text-ink">Local Device Storage:</strong> Your browser&apos;s local storage stores your authenticated
                  session tokens. Your browser&apos;s IndexedDB database (<code className="rounded bg-surface-2 px-1 py-0.5 text-xs font-mono">pookie-chat</code>)
                  stores local cryptographic key material (Identity private key, signed prekey private key, one-time prekeys, ratchet session
                  state, and local app lock PIN verifiers). This key material never leaves your device unencrypted.
                </li>
              </ul>
              <div className="mt-4 rounded-lg bg-surface-2 p-3 text-xs text-ink-dim">
                <strong className="text-ink">What We Do NOT Collect:</strong> Pookie Chat does not set advertising cookies,
                does not track you across other websites, does not use third-party analytics trackers (such as Google Analytics or
                Mixpanel), does not harvest contacts from your address book, and does not record GPS location data.
              </div>
            </section>

            {/* Section 3: End-to-End Encryption */}
            <section>
              <h2 className="text-lg font-bold text-ink">3. End-to-End &amp; Client-Side Encryption</h2>
              <p className="mt-2">
                Pookie Chat uses standard Web Crypto API primitives (X25519/ECDH, AES-256-GCM, SHA-256, and HKDF) to protect
                message confidentiality in transit and at rest on servers:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>
                  Messages and attachments are encrypted directly on the sender&apos;s client device before transmission.
                </li>
                <li>
                  Decryption keys are negotiated directly between endpoints using cryptographic key exchanges. The server does
                  not possess the plaintext keys needed to decrypt conversation contents.
                </li>
                <li>
                  When attachments are stored (whether in managed storage or in your Google Drive), the storage system receives
                  only opaque ciphertext blobs.
                </li>
              </ul>
              <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-ink-dim">
                <strong className="text-amber-800 dark:text-amber-300">Honest Cryptographic Boundaries:</strong> The current
                implementation provides message-level forward secrecy using a forward-secret ratchet protocol. It has not yet
                undergone a formal commercial third-party cryptographic audit. Furthermore, no messaging application can prevent
                a recipient from capturing screenshots, retyping text, or saving files once decrypted on their device, nor can it
                protect against malware, keyloggers, or physical tampering on a compromised endpoint.
              </div>
            </section>

            {/* Section 4: Email Policy */}
            <section>
              <h2 className="text-lg font-bold text-ink">4. Email Identity &amp; Verification</h2>
              <p className="mt-2">
                Under the current Stage 1 authentication architecture:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>A valid email address is required to register new accounts.</li>
                <li>
                  During registration, we send a single-use 6-digit numeric verification code to your email. The code expires in
                  15 minutes and is limited to a maximum of 5 verification attempts.
                </li>
                <li>Resending verification codes is throttled to once every 60 seconds per account.</li>
                <li>
                  Your email address is used solely for account identity, verification, and authentication. We do not send marketing
                  or promotional newsletters.
                </li>
                <li>
                  Sign-in using an email address requires that the email address has been verified. Users may also sign in using
                  their unique username.
                </li>
              </ul>
            </section>

            {/* Section 5: Google Drive */}
            <section>
              <h2 className="text-lg font-bold text-ink">5. Optional User-Owned Google Drive Storage</h2>
              <p className="mt-2">
                Pookie Chat provides an optional feature allowing you to store your chat attachments in your own Google Drive:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>
                  <strong className="text-ink">Explicit Consent:</strong> Google Drive storage is completely optional and inactive
                  until you explicitly connect your Google account in Settings.
                </li>
                <li>
                  <strong className="text-ink">Strictly Minimized Scope:</strong> Pookie Chat requests only the granular{' '}
                  <code className="rounded bg-surface-2 px-1 py-0.5 text-xs font-mono">https://www.googleapis.com/auth/drive.file</code>{' '}
                  permission. This allows Pookie Chat to access <em>only</em> files and folders that Pookie Chat itself creates.
                  Pookie Chat has <strong>zero access</strong> to any other documents, photos, or files in your Google Drive.
                </li>
                <li>
                  <strong className="text-ink">Dedicated Folder:</strong> Pookie Chat operates exclusively within a dedicated folder
                  named &ldquo;Pookie Chat&rdquo; in your Drive root.
                </li>
                <li>
                  <strong className="text-ink">Encrypted at Rest:</strong> All Google OAuth access and refresh tokens stored on our servers
                  are protected using AES-256-GCM authenticated encryption.
                </li>
                <li>
                  <strong className="text-ink">Client-Side Ciphertext:</strong> Uploaded attachments are encrypted on your device
                  before being uploaded to Google Drive. Google receives only encrypted bytes; your plaintext files and conversation
                  keys are never exposed to Google.
                </li>
                <li>
                  <strong className="text-ink">Disconnect &amp; Revocation:</strong> You can disconnect Google Drive at any time from
                  the Settings page. Disconnecting revokes tokens, deletes connection records from our database, and switches storage
                  back to managed storage. Existing files in your Google Drive are not deleted upon disconnection, and you can revoke
                  access independently at any time via your{' '}
                  <a
                    href="https://myaccount.google.com/permissions"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-info underline hover:text-info/80"
                  >
                    Google Account Security Settings
                  </a>.
                </li>
                <li>
                  <strong className="text-ink">Storage Only:</strong> Google OAuth is used strictly for attachment storage; it is
                  not used for Google Sign-In or account authentication.
                </li>
              </ul>
            </section>

            {/* Section 6: How Information Is Used */}
            <section>
              <h2 className="text-lg font-bold text-ink">6. How Information Is Used</h2>
              <p className="mt-2">We use the information we handle strictly to:</p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>Deliver, relay, and synchronize end-to-end encrypted messages and attachments.</li>
                <li>Authenticate your login requests and maintain active device sessions.</li>
                <li>Verify your email address during registration.</li>
                <li>Facilitate user-owned Google Drive storage when voluntarily enabled.</li>
                <li>Prevent brute-force attacks, credential stuffing, and unauthorized account access.</li>
                <li>Maintain operational stability, diagnose technical errors, and apply security updates.</li>
              </ul>
              <p className="mt-3">
                We do not sell, rent, monetize, or trade your personal information. We do not use your messages or attachments to
                train artificial intelligence or machine learning models.
              </p>
            </section>

            {/* Section 7: Sharing & Third Parties */}
            <section>
              <h2 className="text-lg font-bold text-ink">7. Infrastructure &amp; Third-Party Service Providers</h2>
              <p className="mt-2">
                To operate our web service, we partner with reputable cloud infrastructure providers:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>
                  <strong className="text-ink">Frontend Hosting:</strong> Vercel Inc. hosts the web client application and delivers
                  static assets and edge routing.
                </li>
                <li>
                  <strong className="text-ink">Backend API &amp; Real-Time Gateway:</strong> Render Services Inc. hosts the backend
                  API and WebSocket servers.
                </li>
                <li>
                  <strong className="text-ink">Managed Database:</strong> Aiven Ltd. hosts our production PostgreSQL database in a
                  secured cloud environment.
                </li>
                <li>
                  <strong className="text-ink">Email Transport:</strong> A standard SMTP mail transport provider sends email verification
                  codes during account registration.
                </li>
                <li>
                  <strong className="text-ink">Google LLC (Google Drive):</strong> Solely when you explicitly connect user-owned Google Drive
                  storage, Google servers store the encrypted attachment files you upload.
                </li>
              </ul>
              <p className="mt-3">
                <strong className="text-ink">Legal Disclosures:</strong> We may disclose information if required to do so by a valid,
                binding legal order (such as a subpoena or court order). Because messages and attachments are encrypted on the client,
                we can only provide server-held metadata and ciphertext; we cannot provide plaintext message content.
              </p>
            </section>

            {/* Section 8: Retention & Deletion */}
            <section>
              <h2 className="text-lg font-bold text-ink">8. Data Retention &amp; Account Deletion</h2>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>
                  <strong className="text-ink">Account Deletion:</strong> You can permanently delete your account by submitting your
                  current password. Account deletion immediately cascades across our database: your user profile, username, email,
                  active sessions, devices, pairing codes, conversations, ciphertext messages, and attachment references are permanently
                  deleted from our active database.
                </li>
                <li>
                  <strong className="text-ink">Peer Notification:</strong> Deleting your account emits a live notification
                  (<code className="rounded bg-surface-2 px-1 py-0.5 text-xs font-mono">conversation_burned</code>) to active chat
                  participants so they know the conversation has ended.
                </li>
                <li>
                  <strong className="text-ink">Google Drive Files:</strong> If you stored attachments in your own Google Drive, deleting
                  your Pookie Chat account removes the connection records and encrypted tokens from our servers. However, Pookie Chat
                  does not delete the files from your personal Google Drive; you retain complete ownership and can delete them directly
                  in Google Drive at any time.
                </li>
                <li>
                  <strong className="text-ink">Orphaned Attachments:</strong> Unlinked attachment uploads that are never associated
                  with a sent message are automatically swept and deleted after 1 hour.
                </li>
                <li>
                  <strong className="text-ink">Verification Codes:</strong> Email challenge records expire in 15 minutes.
                </li>
              </ul>
            </section>

            {/* Section 9: Security */}
            <section>
              <h2 className="text-lg font-bold text-ink">9. Technical &amp; Operational Security</h2>
              <p className="mt-2">We apply robust technical safeguards across the application stack:</p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>All traffic between your browser and our servers is encrypted in transit using TLS 1.3.</li>
                <li>A strict Content Security Policy (CSP) with per-request cryptographic nonces prevents cross-site scripting (XSS) and code injection.</li>
                <li>Frame-ancestors restrictions prevent clickjacking and framing of Pookie Chat interfaces.</li>
                <li>OAuth tokens and sensitive credentials are encrypted at rest using AES-256-GCM.</li>
                <li>API endpoints are rate-limited to deter brute-force attacks and automated abuse.</li>
              </ul>
            </section>

            {/* Section 10: User Rights */}
            <section>
              <h2 className="text-lg font-bold text-ink">10. User Rights &amp; Privacy Controls</h2>
              <p className="mt-2">You have direct control over your privacy within Pookie Chat:</p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li><strong className="text-ink">Read Receipts:</strong> Enable or disable read receipts in Settings.</li>
                <li><strong className="text-ink">Typing Indicators:</strong> Toggle typing status visibility in Settings.</li>
                <li><strong className="text-ink">Discovery:</strong> Enable or disable whether others can find you by your username.</li>
                <li><strong className="text-ink">Remote Session Log-Out:</strong> Review all active browser sessions and remotely revoke unrecognized devices.</li>
                <li><strong className="text-ink">Storage Disconnect:</strong> Connect or disconnect personal Google Drive storage at will.</li>
                <li><strong className="text-ink">App Lock:</strong> Configure a local PIN to guard your open tab from local physical snooping.</li>
                <li><strong className="text-ink">Account Deletion:</strong> Permanently delete your entire account and associated server records.</li>
              </ul>
            </section>

            {/* Section 11: Children's Privacy */}
            <section>
              <h2 className="text-lg font-bold text-ink">11. Children&apos;s Privacy</h2>
              <p className="mt-2">
                Pookie Chat is not intended for or directed toward children under the age of 13 (or under 16 where required
                by local jurisdiction). We do not knowingly collect or solicit personal information from children. If we learn
                that personal information has been collected from a child without appropriate parental consent, we will promptly
                delete that information.
              </p>
            </section>

            {/* Section 12: Changes to this Policy */}
            <section>
              <h2 className="text-lg font-bold text-ink">12. Changes to this Privacy Policy</h2>
              <p className="mt-2">
                We may periodically update this Privacy Policy to reflect technical enhancements, architectural updates,
                or regulatory requirements. Any modifications will be posted to this page with an updated &ldquo;Effective Date.&rdquo;
                We encourage you to review this policy periodically.
              </p>
            </section>

            {/* Section 13: Contact Information */}
            <section>
              <h2 className="text-lg font-bold text-ink">13. Contact Information</h2>
              <p className="mt-2">
                For questions, concerns, or requests regarding this Privacy Policy or your personal information, please visit our{' '}
                <Link href="/support" className="text-info underline hover:text-info/80">Support Page</Link>
                {supportEmail ? (
                  <> or email us directly at <a href={`mailto:${supportEmail}`} className="text-info underline hover:text-info/80">{supportEmail}</a></>
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
