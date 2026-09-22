import { Controller, Get, Post, Query, Req, Res, UseGuards, Inject } from '@nestjs/common';
import type { Response } from 'express';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { GoogleDriveOAuthService } from './google-drive-oauth.service';
import { AppConfig } from '../config/env';
import { APP_CONFIG } from '../config/config.module';

@Controller('api/storage/google-drive')
export class GoogleDriveOAuthController {
  constructor(
    private readonly oauth: GoogleDriveOAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @UseGuards(AccessTokenGuard)
  @Get('status')
  async getStatus(@Req() req: AuthenticatedRequest) {
    return this.oauth.getStatus(req.auth.userId);
  }

  @UseGuards(AccessTokenGuard)
  @Get('connect')
  async connect(@Req() req: AuthenticatedRequest) {
    return this.oauth.generateConnectUrl(req.auth.userId);
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    const webOrigin = this.config.webOrigin;
    if (error) {
      return res.redirect(`${webOrigin}/settings?drive_error=access_denied`);
    }

    try {
      await this.oauth.handleCallback(code, state);
      return res.redirect(`${webOrigin}/settings?drive_connected=true`);
    } catch (err) {
      return res.redirect(`${webOrigin}/settings?drive_error=oauth_failed`);
    }
  }

  @UseGuards(AccessTokenGuard)
  @Post('disconnect')
  async disconnect(@Req() req: AuthenticatedRequest) {
    await this.oauth.disconnect(req.auth.userId);
    return { ok: true };
  }
}
