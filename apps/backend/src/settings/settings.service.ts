import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface UpdateSettingsInput {
  readReceiptsEnabled?: boolean;
  typingIndicatorEnabled?: boolean;
  notificationContentVisible?: boolean;
  accentColor?: string | null;
  appLockEnabled?: boolean;
  appLockTimeoutSeconds?: number;
  appLockMethod?: string | null;
  screenshotProtectionEnabled?: boolean;
  usernameSearchEnabled?: boolean;
  lastSeenEnabled?: boolean;
}

// Validated against the strict default palette (docs/04-DESIGN-SYSTEM.md
// §1) plus a small set of additional options offered only inside the
// customization screen itself — never applied anywhere the default theme
// is still in effect.
const ALLOWED_ACCENT_COLORS = new Set([
  null,
  '#3B82F6', // default blue — choosing this explicitly is a no-op, kept for simplicity
  '#8B5CF6',
  '#EC4899',
  '#F59E0B',
  '#14B8A6',
]);

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string) {
    const existing = await this.prisma.userSettings.findUnique({ where: { userId } });
    if (existing) return existing;
    return this.prisma.userSettings.create({ data: { userId } }); // defaults from the schema apply
  }

  async update(userId: string, input: UpdateSettingsInput) {
    if (input.accentColor !== undefined && !ALLOWED_ACCENT_COLORS.has(input.accentColor)) {
      throw new BadRequestException('Unsupported accent color');
    }
    await this.get(userId); // ensure a row exists
    return this.prisma.userSettings.update({ where: { userId }, data: input });
  }
}
