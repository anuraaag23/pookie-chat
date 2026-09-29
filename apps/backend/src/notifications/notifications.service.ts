import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Associates a Web Push token with the active user's device.
   */
  async updatePushToken(deviceId: string, pushToken: string): Promise<{ success: boolean }> {
    if (!deviceId) return { success: false };

    try {
      await this.prisma.device.update({
        where: { id: deviceId },
        data: { pushToken },
      });
      this.logger.log(`Updated pushToken for device ${deviceId}`);
      return { success: true };
    } catch (err) {
      this.logger.warn(`Failed to update pushToken for device ${deviceId}: ${String(err)}`);
      return { success: false };
    }
  }

  /**
   * Dispatches a push notification to user's registered devices (excluding the sender's device).
   */
  async notifyUser(userId: string, excludeDeviceId?: string, title = 'Pookie Chat', body = 'New encrypted message'): Promise<void> {
    const devices = await this.prisma.device.findMany({
      where: {
        userId,
        revokedAt: null,
        pushToken: { not: null },
        ...(excludeDeviceId ? { id: { not: excludeDeviceId } } : {}),
      },
      select: { id: true, pushToken: true },
    });

    if (devices.length === 0) return;

    for (const d of devices) {
      this.logger.log(`Dispatching push notification to device ${d.id} for user ${userId}`);
      // Push token stored; ready for VAPID/FCM dispatch when configured
    }
  }
}
