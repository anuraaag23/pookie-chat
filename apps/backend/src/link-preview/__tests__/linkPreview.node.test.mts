import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, parseHtmlMetadata } from '../../domain/linkPreview.ts';

test('LinkPreview SSRF: Flags private and cloud metadata IP ranges', () => {
  // Localhost / Loopback
  assert.equal(isPrivateIp('127.0.0.1'), true, '127.0.0.1 must be flagged');
  assert.equal(isPrivateIp('127.1.2.3'), true, '127.x.x.x must be flagged');
  assert.equal(isPrivateIp('::1'), true, '::1 must be flagged');

  // AWS / GCP / Cloud metadata
  assert.equal(isPrivateIp('169.254.169.254'), true, '169.254.x.x link-local must be flagged');

  // Private RFC 1918 networks
  assert.equal(isPrivateIp('10.0.0.1'), true, '10.x.x.x must be flagged');
  assert.equal(isPrivateIp('192.168.1.1'), true, '192.168.x.x must be flagged');
  assert.equal(isPrivateIp('172.16.0.5'), true, '172.16.x.x must be flagged');
  assert.equal(isPrivateIp('172.31.255.255'), true, '172.31.x.x must be flagged');

  // Zero network
  assert.equal(isPrivateIp('0.0.0.0'), true, '0.0.0.0 must be flagged');

  // Public IP addresses must NOT be flagged
  assert.equal(isPrivateIp('8.8.8.8'), false, '8.8.8.8 is public');
  assert.equal(isPrivateIp('1.1.1.1'), false, '1.1.1.1 is public');
  assert.equal(isPrivateIp('142.250.190.46'), false, 'Google public IP is not private');
});

test('LinkPreview HTML Parser: Extracts OG metadata and resolves relative image URLs', () => {
  const sampleHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Ignored Fallback Title</title>
        <meta property="og:site_name" content="Example News" />
        <meta property="og:title" content="Breaking: Secure Chat Released &amp; Verified" />
        <meta property="og:description" content="A brand-new zero-knowledge messaging system has arrived &quot;today&quot;." />
        <meta property="og:image" content="/assets/hero-banner.jpg" />
      </head>
      <body><h1>Content</h1></body>
    </html>
  `;

  const baseUrl = new URL('https://news.example.com/articles/123');
  const metadata = parseHtmlMetadata(sampleHtml, baseUrl);

  assert.equal(metadata.title, 'Breaking: Secure Chat Released & Verified');
  assert.equal(metadata.description, 'A brand-new zero-knowledge messaging system has arrived "today".');
  assert.equal(metadata.siteName, 'Example News');
  assert.equal(metadata.image, 'https://news.example.com/assets/hero-banner.jpg', 'Relative image must resolve against base URL');
  assert.equal(metadata.hostname, 'news.example.com');
});

test('LinkPreview HTML Parser: Falls back gracefully to standard tags when OG is missing', () => {
  const minimalHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Plain Document Title</title>
        <meta name="description" content="Plain meta description tag." />
      </head>
      <body></body>
    </html>
  `;

  const baseUrl = new URL('https://docs.pookie.chat/faq');
  const metadata = parseHtmlMetadata(minimalHtml, baseUrl);

  assert.equal(metadata.title, 'Plain Document Title');
  assert.equal(metadata.description, 'Plain meta description tag.');
  assert.equal(metadata.image, null);
  assert.equal(metadata.siteName, 'docs.pookie.chat');
});
