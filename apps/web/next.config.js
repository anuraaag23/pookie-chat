/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Note: Content-Security-Policy is enforced dynamically with per-request
  // cryptographic nonces in apps/web/middleware.ts. Static CSP in next.config.js
  // cannot support per-request nonces and blocks Next.js production bootstrap scripts.
};

module.exports = nextConfig;
