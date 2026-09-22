/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    // messageCache.ts's comment on plaintext-at-rest in IndexedDB names
    // this as the defense-in-depth control that actually matters for XSS —
    // it didn't exist anywhere in the app until now. No inline scripts, no
    // third-party origins: this is a strict E2EE messenger, not a page
    // that should ever need to load code or frames from elsewhere.
    const apiOrigin = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    const wsOrigin = apiOrigin.replace(/^http/, 'ws');
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      `connect-src 'self' ${apiOrigin} ${wsOrigin}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    return [
      {
        source: '/(.*)',
        headers: [{ key: 'Content-Security-Policy', value: csp }],
      },
    ];
  },
};

module.exports = nextConfig;
