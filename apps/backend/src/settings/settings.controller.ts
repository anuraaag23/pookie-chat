import { Body, Controller, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { SettingsService, FeaturePasswordType } from './settings.service';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';

class UpdateSettingsDto {
  @IsOptional() @IsBoolean() readReceiptsEnabled?: boolean;
  @IsOptional() @IsBoolean() typingIndicatorEnabled?: boolean;
  @IsOptional() @IsBoolean() notificationContentVisible?: boolean;
  @IsOptional() @IsString() accentColor?: string | null;
  @IsOptional() @IsBoolean() appLockEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(3600) appLockTimeoutSeconds?: number;
  @IsOptional() @IsIn(['pin', 'biometric', null]) appLockMethod?: string | null;
  @IsOptional() @IsBoolean() usernameSearchEnabled?: boolean;
  @IsOptional() @IsBoolean() lastSeenEnabled?: boolean;
  @IsOptional() @IsBoolean() screenshotProtectionEnabled?: boolean;
}

class SetFeaturePasswordDto {
  @IsIn(['burn', 'lock', 'hide'])
  feature!: FeaturePasswordType;

  @IsString()
  @Length(4, 256)
  newPassword!: string;

  @IsOptional()
  @IsString()
  currentPassword?: string;
}

class VerifyFeaturePasswordDto {
  @IsIn(['burn', 'lock', 'hide'])
  feature!: FeaturePasswordType;

  @IsString()
  password!: string;
}

class RemoveFeaturePasswordDto {
  @IsIn(['burn', 'lock', 'hide'])
  feature!: FeaturePasswordType;

  @IsString()
  currentPassword!: string;
}

@UseGuards(AccessTokenGuard)
@Controller('api/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(@Req() req: AuthenticatedRequest) {
    return this.settings.get(req.auth.userId);
  }

  @Patch()
  update(@Req() req: AuthenticatedRequest, @Body() dto: UpdateSettingsDto) {
    return this.settings.update(req.auth.userId, dto);
  }

  /**
   * Set or update a feature-specific password (burn, lock, hide).
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('feature-passwords/set')
  setFeaturePassword(@Req() req: AuthenticatedRequest, @Body() dto: SetFeaturePasswordDto) {
    return this.settings.setFeaturePassword(req.auth.userId, dto.feature, dto.newPassword, dto.currentPassword);
  }

  /**
   * Verify a feature-specific password before performing an action (burn, lock, hide).
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('feature-passwords/verify')
  verifyFeaturePassword(@Req() req: AuthenticatedRequest, @Body() dto: VerifyFeaturePasswordDto) {
    return this.settings.verifyFeaturePassword(req.auth.userId, dto.feature, dto.password);
  }

  /**
   * Remove a feature-specific password.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('feature-passwords/remove')
  removeFeaturePassword(@Req() req: AuthenticatedRequest, @Body() dto: RemoveFeaturePasswordDto) {
    return this.settings.removeFeaturePassword(req.auth.userId, dto.feature, dto.currentPassword);
  }
}
