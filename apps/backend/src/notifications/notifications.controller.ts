import { Controller, Post, Body, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { NotificationsService } from './notifications.service';

class UpdatePushTokenDto {
  pushToken!: string;
}

@UseGuards(AccessTokenGuard)
@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('push-token')
  async updatePushToken(@Req() req: AuthenticatedRequest, @Body() body: UpdatePushTokenDto) {
    if (!body?.pushToken || typeof body.pushToken !== 'string') {
      throw new BadRequestException('A valid pushToken string is required');
    }
    return this.notificationsService.updatePushToken(req.auth.deviceId, body.pushToken);
  }

  @Post('test')
  async testNotification(@Req() req: AuthenticatedRequest) {
    await this.notificationsService.notifyUser(req.auth.userId, undefined, 'Pookie Chat', 'Test notification received successfully!');
    return { success: true, message: 'Test notification queued' };
  }
}
