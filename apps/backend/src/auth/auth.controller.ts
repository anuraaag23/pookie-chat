import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString } from 'class-validator';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto, UsernameAvailabilityDto, ChangePasswordDto, ChangeUsernameDto, VerifyEmailDto, ResendVerificationDto, AddEmailDto } from './dto/auth.dto';
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
  constructor(private readonly auth: AuthService) {}

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
