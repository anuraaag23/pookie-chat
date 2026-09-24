import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { ConversationRequestsService } from './conversation-requests.service';
import { CreateConversationRequestDto } from './dto/conversation-requests.dto';

@Controller('api/conversation-requests')
@UseGuards(AccessTokenGuard)
export class ConversationRequestsController {
  constructor(private readonly requestsService: ConversationRequestsService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  async sendRequest(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateConversationRequestDto,
  ) {
    return this.requestsService.sendRequest(req.auth.userId, dto);
  }

  @Get('pending')
  async listPending(@Req() req: AuthenticatedRequest) {
    return this.requestsService.listPending(req.auth.userId);
  }

  @Post(':id/accept')
  async acceptRequest(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.requestsService.acceptRequest(req.auth.userId, id);
  }

  @Post(':id/reject')
  async rejectRequest(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.requestsService.rejectRequest(req.auth.userId, id);
  }

  @Post(':id/cancel')
  async cancelRequest(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.requestsService.cancelRequest(req.auth.userId, id);
  }
}
