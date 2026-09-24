import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards, Inject } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { GoogleAuthService } from './google-auth.service';
import { AppConfig } from '../config/env';
import { APP_CONFIG } from '../config/config.module';
import {
  RegisterDto,
  LoginDto,
  UsernameAvailabilityDto,
  ChangePasswordDto,
  ChangeUsernameDto,
  VerifyEmailDto,
  ResendVerificationDto,
  AddEmailDto,
  GoogleAuthExchangeDto,
  GoogleTokenDto,
} from './dto/auth.dto';
import { AccessTokenGuard, AuthenticatedRequest } from './access-token.guard';

class RefreshDto {
  @IsString()
  refreshToken!: string;
}

class DeleteAccountDto {
  @IsString()
  password!: string;
}

/** Server-observed, never trusted from the request body — a client claiming a different browser/IP proves nothing. */
function requestContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly googleAuth: GoogleAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('google/config')
  getGoogleConfig() {
    return this.googleAuth.getConfig();
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('google/url')
  getGoogleAuthUrl(
    @Query('action') action?: 'login' | 'register',
    @Query('returnTo') returnTo?: string,
  ) {
    return this.googleAuth.generateAuthUrl(action, returnTo);
  }

  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    const webOrigin = this.config.webOrigin;
    if (error) {
      return res.redirect(`${webOrigin}/login?google_error=${encodeURIComponent(error)}`);
    }

    try {
      const result = await this.googleAuth.handleCallback(code, state);
      const targetPath = result.action === 'register' ? '/register' : '/login';
      const redirectUrl = new URL(`${webOrigin}${targetPath}`);
      redirectUrl.searchParams.set('google_ticket', result.ticket);
      if (result.returnTo) {
        redirectUrl.searchParams.set('next', result.returnTo);
      }
      return res.redirect(redirectUrl.toString());
    } catch (err: any) {
      const msg = encodeURIComponent(err?.message || 'Authentication failed');
      return res.redirect(`${webOrigin}/login?google_error=${msg}`);
    }
  }

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('google/exchange')
  async exchangeGoogleTicket(@Req() req: Request, @Body() dto: GoogleAuthExchangeDto) {
    const profile = this.googleAuth.consumeTicket(dto.ticket);
    return this.auth.loginOrRegisterGoogleUser(profile, dto, requestContext(req));
  }

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('google/token')
  async verifyGoogleToken(@Req() req: Request, @Body() dto: GoogleTokenDto) {
    const profile = await this.googleAuth.verifyIdToken(dto.idToken);
    return this.auth.loginOrRegisterGoogleUser(profile, dto, requestContext(req));
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  register(@Req() req: Request, @Body() dto: RegisterDto) {
    return this.auth.register(dto, requestContext(req));
  }

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('resend-verification')
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.auth.resendVerification(dto);
  }

  @UseGuards(AccessTokenGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('email')
  addEmail(@Req() req: AuthenticatedRequest, @Body() dto: AddEmailDto) {
    return this.auth.addEmail(req.auth.userId, dto);
  }

  // Unauthenticated by necessity — this runs before any account (and so
  // any access token) exists. Advisory only: registration's own DB
  // write is the real, race-safe uniqueness check (see
  // AuthService.register). Throttled well below the global default
  // since its whole purpose is testing guesses against real usernames.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('username-availability')
  usernameAvailability(@Query() dto: UsernameAvailabilityDto) {
    return this.auth.checkUsernameAvailability(dto.username);
  }

  // Stricter than the global default rate limit — login is the classic
  // credential-stuffing target.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Req() req: Request, @Body() dto: LoginDto) {
    return this.auth.login(dto, requestContext(req));
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
    return { ok: true };
  }

  @UseGuards(AccessTokenGuard)
  @Get('sessions')
  listSessions(@Req() req: AuthenticatedRequest) {
    return this.auth.listSessions(req.auth.userId, req.auth.deviceId);
  }

  @UseGuards(AccessTokenGuard)
  @Delete('sessions/:id')
  async revokeSession(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.auth.revokeSession(req.auth.userId, id);
    return { ok: true };
  }

  @UseGuards(AccessTokenGuard)
  @Post('sessions/revoke-others')
  async revokeOtherSessions(@Req() req: AuthenticatedRequest) {
    return this.auth.revokeOtherSessions(req.auth.userId, req.auth.deviceId);
  }

  @UseGuards(AccessTokenGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Patch('username')
  async changeUsername(@Req() req: AuthenticatedRequest, @Body() dto: ChangeUsernameDto) {
    return this.auth.changeUsername(req.auth.userId, dto.username);
  }

  // Same throttling class as login: this is the one non-login endpoint
  // that also takes a password guess, so it gets the same protection
  // against credential stuffing / brute force.
  @UseGuards(AccessTokenGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Patch('password')
  async changePassword(@Req() req: AuthenticatedRequest, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(req.auth.userId, dto.currentPassword, dto.newPassword);
    return { ok: true };
  }

  @UseGuards(AccessTokenGuard)
  @Delete('account')
  async deleteAccount(@Req() req: AuthenticatedRequest, @Body() dto: DeleteAccountDto) {
    await this.auth.deleteAccount(req.auth.userId, dto.password);
    return { ok: true };
  }
}
