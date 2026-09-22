import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { MessagesService } from './messages.service';
import { SendMessageDto, SyncQueryDto } from './dto/messages.dto';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';

class EditMessageDto {
  @IsString()
  @MaxLength(65536)
  ciphertext!: string;

  @IsString()
  @MaxLength(32)
  iv!: string;
}

@UseGuards(AccessTokenGuard)
@Controller('api/messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  send(@Req() req: AuthenticatedRequest, @Body() dto: SendMessageDto) {
    return this.messages.send(req.auth.userId, dto);
  }

  @Get('sync')
  sync(@Req() req: AuthenticatedRequest, @Query() query: SyncQueryDto) {
    return this.messages.sync(req.auth.userId, query.conversationId, query.after);
  }

  @Post(':id/read')
  async markRead(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.messages.markRead(req.auth.userId, id);
    return { ok: true };
  }

  @Delete(':id')
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.messages.deleteMessage(req.auth.userId, id);
    return { ok: true };
  }

  @Patch(':id')
  async edit(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: EditMessageDto) {
    await this.messages.editMessage(req.auth.userId, id, dto.ciphertext, dto.iv);
    return { ok: true };
  }
}
