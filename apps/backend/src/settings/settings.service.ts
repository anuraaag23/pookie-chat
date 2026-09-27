import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  hashPassword,
  verifyPassword,
  validatePassword,
} from '../domain/password';

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

export type FeaturePasswordType = 'burn' | 'lock' | 'hide';

const ALLOWED_ACCENT_COLORS = new Set([
  null,
  '#3B82F6',
  '#8B5CF6',
  '#EC4899',
  '#F59E0B',
  '#14B8A6',
]);

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string) {
    let settings = await this.prisma.userSettings.findUnique({ where: { userId } });
    if (!settings) {
      settings = await this.prisma.userSettings.create({ data: { userId } });
    }

    // Never expose password hashes to client (Issue #6)
    const {
      burnPasswordHash,
      chatLockPasswordHash,
      hideChatPasswordHash,
      ...publicSettings
    } = settings;

    return {
      ...publicSettings,
      hasBurnPassword: !!burnPasswordHash,
      hasChatLockPassword: !!chatLockPasswordHash,
      hasHideChatPassword: !!hideChatPasswordHash,
    };
  }

  async update(userId: string, input: UpdateSettingsInput) {
    if (input.accentColor !== undefined && !ALLOWED_ACCENT_COLORS.has(input.accentColor)) {
      throw new BadRequestException('Unsupported accent color');
    }
    await this.get(userId); // ensure a row exists
    const updated = await this.prisma.userSettings.update({ where: { userId }, data: input });
    const {
      burnPasswordHash,
      chatLockPasswordHash,
      hideChatPasswordHash,
      ...publicSettings
    } = updated;

    return {
      ...publicSettings,
      hasBurnPassword: !!burnPasswordHash,
      hasChatLockPassword: !!chatLockPasswordHash,
      hasHideChatPassword: !!hideChatPasswordHash,
    };
  }

  private getFieldForFeature(feature: FeaturePasswordType): 'burnPasswordHash' | 'chatLockPasswordHash' | 'hideChatPasswordHash' {
    switch (feature) {
      case 'burn':
        return 'burnPasswordHash';
      case 'lock':
        return 'chatLockPasswordHash';
      case 'hide':
        return 'hideChatPasswordHash';
      default:
        throw new BadRequestException('Invalid feature type');
    }
  }

  /**
   * Set or update a feature-specific password (Issues #6, #7, #11).
   * Password is scrypt-hashed with salt; never saved in plaintext.
   */
  async setFeaturePassword(
    userId: string,
    feature: FeaturePasswordType,
    newPassword: string,
    currentPassword?: string,
  ) {
    const val = validatePassword(newPassword);
    if (!val.valid) {
      throw new BadRequestException(val.error ?? 'Invalid password');
    }

    const field = this.getFieldForFeature(feature);
    const existing = await this.prisma.userSettings.findUnique({ where: { userId } });

    // If already configured, require current password verification
    if (existing && existing[field]) {
      if (!currentPassword) {
        throw new UnauthorizedException('Current password required to change feature password');
      }
      const ok = await verifyPassword(currentPassword, existing[field]!);
      if (!ok) {
        throw new UnauthorizedException('Incorrect current password');
      }
    }

    const hash = await hashPassword(newPassword);
    await this.prisma.userSettings.upsert({
      where: { userId },
      create: { userId, [field]: hash },
      update: { [field]: hash },
    });

    return { success: true, feature };
  }

  /**
   * Verify a feature-specific password (Issues #6, #7, #11).
   */
  async verifyFeaturePassword(
    userId: string,
    feature: FeaturePasswordType,
    password: string,
  ): Promise<{ valid: boolean }> {
    if (!password) {
      throw new BadRequestException('Password required');
    }

    const field = this.getFieldForFeature(feature);
    const settings = await this.prisma.userSettings.findUnique({ where: { userId } });

    if (!settings || !settings[field]) {
      throw new BadRequestException('Password not configured for this feature');
    }

    const valid = await verifyPassword(password, settings[field]!);
    if (!valid) {
      throw new UnauthorizedException('Incorrect password');
    }

    return { valid: true };
  }

  /**
   * Remove a feature-specific password (optional removal).
   */
  async removeFeaturePassword(
    userId: string,
    feature: FeaturePasswordType,
    currentPassword: string,
  ) {
    const field = this.getFieldForFeature(feature);
    const settings = await this.prisma.userSettings.findUnique({ where: { userId } });

    if (!settings || !settings[field]) {
      return { success: true };
    }

    const ok = await verifyPassword(currentPassword, settings[field]!);
    if (!ok) {
      throw new UnauthorizedException('Incorrect current password');
    }

    await this.prisma.userSettings.update({
      where: { userId },
      data: { [field]: null },
    });

    return { success: true };
  }
}
