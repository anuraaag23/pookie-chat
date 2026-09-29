import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { LinkPreviewService, LinkPreviewResult } from './link-preview.service';

@UseGuards(AccessTokenGuard)
@Controller('api/link-preview')
export class LinkPreviewController {
  constructor(private readonly linkPreviewService: LinkPreviewService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get()
  async getPreview(@Query('url') rawUrl?: string): Promise<LinkPreviewResult> {
    if (!rawUrl || typeof rawUrl !== 'string') {
      throw new BadRequestException('A valid URL query parameter is required');
    }
    return this.linkPreviewService.getPreview(rawUrl);
  }
}
