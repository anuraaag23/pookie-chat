import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as dns from 'node:dns';
import { isPrivateIp, parseHtmlMetadata, LinkPreviewResult } from '../domain/linkPreview';

export { LinkPreviewResult };

@Injectable()
export class LinkPreviewService {
  private readonly logger = new Logger(LinkPreviewService.name);

  isPrivateIp(ip: string): boolean {
    return isPrivateIp(ip);
  }

  parseHtmlMetadata(html: string, baseUrl: URL): LinkPreviewResult {
    return parseHtmlMetadata(html, baseUrl);
  }

  /**
   * Safely fetches open graph metadata for a target URL.
   * Strips headers/cookies, enforces SSRF blocks, and enforces tight size/time limits.
   */
  async getPreview(rawUrl: string): Promise<LinkPreviewResult> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new BadRequestException('Invalid URL format');
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new BadRequestException('Only HTTP and HTTPS links are supported');
    }

    // SSRF Check: resolve hostname to IP
    try {
      const { address } = await dns.promises.lookup(parsedUrl.hostname);
      if (isPrivateIp(address)) {
        throw new BadRequestException('Access to private/local network addresses is prohibited');
      }
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('Could not resolve hostname');
    }

    // Fetch with AbortController timeout & size cap
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    try {
      const response = await fetch(parsedUrl.toString(), {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PookieChatBot/1.0; +https://pookie.chat)',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        throw new BadRequestException(`Target responded with status ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        return {
          url: parsedUrl.toString(),
          title: null,
          description: null,
          image: null,
          siteName: parsedUrl.hostname,
          hostname: parsedUrl.hostname,
        };
      }

      // Stream read with max 128KB limit
      const reader = response.body?.getReader();
      let html = '';
      if (reader) {
        let bytesRead = 0;
        const maxBytes = 128 * 1024;
        while (bytesRead < maxBytes) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          bytesRead += value.length;
          html += new TextDecoder('utf-8').decode(value, { stream: true });
        }
        reader.cancel().catch(() => {});
      } else {
        html = await response.text();
      }

      return parseHtmlMetadata(html, parsedUrl);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new BadRequestException('Link preview request timed out');
      }
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Failed to retrieve link preview');
    } finally {
      clearTimeout(timeout);
    }
  }
}
