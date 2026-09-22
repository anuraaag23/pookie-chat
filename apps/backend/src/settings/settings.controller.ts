import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SettingsService } from './settings.service';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';

class UpdateSettingsDto {
  @IsOptional() @IsBoolean() readReceiptsEnabled?: boolean;
  @IsOptional() @IsBoolean() typingIndicatorEnabled?: boolean;
  @IsOptional() @IsBoolean() notificationContentVisible?: boolean;
  @IsOptional() @IsString() accentColor?: string | null;
  @IsOptional() @IsBoolean() appLockEnabled?: boolean;
  // 0 = "Immediately". apps/web/lib/applock/state.ts's shouldBeLocked()
  // already does the right thing with 0 (Date.now() - lastActiveAt > 0
  // is true the moment any time at all has passed since the app left
  // the foreground) — this floor of 15 was the only thing actually
  // preventing "Immediately" from ever being selectable.
  @IsOptional() @IsInt() @Min(0) @Max(3600) appLockTimeoutSeconds?: number;
  @IsOptional() @IsIn(['pin', 'biometric', null]) appLockMethod?: string | null;
  // Whether other users can find this account via GET /api/users/search
  // and start a new chat with it — see users/users.service.ts for
  // enforcement (which is always server-side; this setting is never
  // trusted from anywhere else). Does not affect existing conversations.
  @IsOptional() @IsBoolean() usernameSearchEnabled?: boolean;
  // Android-only (FLAG_SECURE — see docs/00-ARCHITECTURE.md and
  // docs/02-DATABASE-SCHEMA.md). There is no web equivalent: a browser
  // cannot prevent a screenshot, a screen recording, or another device
  // photographing the screen. This field is intentionally not exposed
  // as a toggle anywhere in the web UI (apps/web/app/settings/page.tsx
  // only references it in a TypeScript interface, never renders a
  // control for it) — do not add one without first implementing and
  // clearly labeling whatever the web's actual, honest capability is;
  // a web toggle with this name would promise something the platform
  // cannot deliver.
  @IsOptional() @IsBoolean() screenshotProtectionEnabled?: boolean;
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
}
