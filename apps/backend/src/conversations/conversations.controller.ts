import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ConversationsService } from './conversations.service';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { DISAPPEARING_OPTIONS } from '../domain/messageState';

class SetDisappearingDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  timerSeconds?: number | null;

  @IsIn(['SENT', 'DELIVERED', 'READ'])
  trigger!: 'SENT' | 'DELIVERED' | 'READ';
}

class BurnConversationDto {
  @IsOptional()
  @IsString()
  password?: string;
}

class ExtendTemporaryChatDto {
  @IsInt()
  @Min(1)
  @Max(90 * 24 * 60 * 60)
  durationSeconds!: number;
}

@UseGuards(AccessTokenGuard)
@Controller('api/conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.conversations.list(req.auth.userId);
  }

  @Get('disappearing-options')
  disappearingOptions() {
    return DISAPPEARING_OPTIONS;
  }

  // Registered after the static 'disappearing-options' route above —
  // NestJS/Express match routes in declaration order per controller, so
  // a ':id' route declared first would swallow that literal path as if
  // "disappearing-options" were an id.
  //
  // Deliberately does not require the conversation to be ACTIVE (unlike
  // every other endpoint in this controller): its purpose is precisely
  // to let a past participant learn their conversation was burned, so a
  // DELETED conversation is a valid, expected response here, not an
  // error — see ConversationsService.getStatus.
  @Get(':id')
  async getStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.conversations.getStatus(req.auth.userId, id);
  }

  @Post(':id/block')
  async block(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.conversations.block(req.auth.userId, id);
    return { ok: true };
  }

  @Post(':id/unblock')
  async unblock(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.conversations.unblock(req.auth.userId, id);
    return { ok: true };
  }

  @Post(':id/burn')
  async burn(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto?: BurnConversationDto) {
    await this.conversations.burn(req.auth.userId, id, dto?.password);
    return { ok: true };
  }

  @Post(':id/disappearing')
  async setDisappearing(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: SetDisappearingDto) {
    await this.conversations.setDisappearingTimer(req.auth.userId, id, dto.timerSeconds ?? null, dto.trigger);
    return { ok: true };
  }

  @Post(':id/temporary/extend')
  async extendTemporary(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: ExtendTemporaryChatDto,
  ) {
    return this.conversations.extendTemporaryChat(req.auth.userId, id, dto.durationSeconds);
  }
}
