import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsObject, IsOptional, IsString } from 'class-validator';
import { HandshakeService } from './handshake.service';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';

class StoreHandshakeDto {
  @IsString()
  conversationId!: string;

  @IsObject()
  handshakeMessage!: Record<string, unknown>;

  // SECURITY AUDIT F4 HARDENING: sessionEpoch is required — every current
  // client sends the epoch it got back from PairingService.redeem.
  @IsInt()
  sessionEpoch!: number;
}

@UseGuards(AccessTokenGuard)
@Controller('api/handshake')
export class HandshakeController {
  constructor(private readonly handshake: HandshakeService) {}

  @Post()
  async store(@Req() req: AuthenticatedRequest, @Body() dto: StoreHandshakeDto) {
    await this.handshake.store(req.auth.userId, dto.conversationId, dto.handshakeMessage, dto.sessionEpoch);
    return { ok: true };
  }

  @Get()
  async fetch(@Req() req: AuthenticatedRequest, @Query('conversationId') conversationId: string) {
    return this.handshake.fetch(req.auth.userId, conversationId);
  }
}
