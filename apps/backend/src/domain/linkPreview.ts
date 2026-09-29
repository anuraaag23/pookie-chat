export interface LinkPreviewResult {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  hostname: string;
}

/**
 * Pure TypeScript utilities for SSRF validation and HTML metadata extraction.
 * Free of framework decorators so it can be verified directly by unit tests.
 */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;

  // IPv6 loopback / local
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:')) {
    return true;
  }

  // Convert IPv4 to octets
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false; // not standard IPv4
  }

  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined) return false;

  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 10.0.0.0/8 (Private)
  if (a === 10) return true;
  // 172.16.0.0/12 (Private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (Private)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (Link-local / AWS / GCP / Cloud Metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;

  return false;
}

export function parseHtmlMetadata(html: string, baseUrl: URL): LinkPreviewResult {
  const extractMeta = (property: string): string | null => {
    const propRegex = new RegExp(
      `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`,
      'i',
    );
    const match = html.match(propRegex);
    if (match && match[1]) return match[1].trim();

    const altRegex = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`,
      'i',
    );
    const altMatch = html.match(altRegex);
    return altMatch && altMatch[1] ? altMatch[1].trim() : null;
  };

  let title =
    extractMeta('og:title') ||
    extractMeta('twitter:title') ||
    extractMeta('title');

  if (!title) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    title = titleMatch && titleMatch[1] ? titleMatch[1].trim() : null;
  }

  const description =
    extractMeta('og:description') ||
    extractMeta('twitter:description') ||
    extractMeta('description');

  let image =
    extractMeta('og:image') ||
    extractMeta('twitter:image') ||
    extractMeta('image');

  // Resolve relative image URLs safely
  if (image && !image.startsWith('http://') && !image.startsWith('https://')) {
    try {
      image = new URL(image, baseUrl).toString();
    } catch {
      image = null;
    }
  }

  const siteName =
    extractMeta('og:site_name') ||
    baseUrl.hostname.replace(/^www\./, '');

  return {
    url: baseUrl.toString(),
    title: title ? decodeHtmlEntities(title).slice(0, 150) : null,
    description: description ? decodeHtmlEntities(description).slice(0, 300) : null,
    image,
    siteName,
    hostname: baseUrl.hostname,
  };
}

export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
