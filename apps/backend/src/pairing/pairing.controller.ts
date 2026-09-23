import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PairingService } from './pairing.service';
import { CreatePairingDto, RedeemPairingDto } from './dto/pairing.dto';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';

@UseGuards(AccessTokenGuard)
@Controller('api/pairing')
export class PairingController {
  constructor(private readonly pairing: PairingService) {}

  @Get('forever')
  getForeverCode(@Req() req: AuthenticatedRequest) {
    return this.pairing.getActiveForeverCode(req.auth.userId);
  }

  @Post('forever')
  createForeverCode(@Req() req: AuthenticatedRequest) {
    return this.pairing.create(req.auth.userId, null);
  }

  @Delete('forever')
  async deleteForeverCode(@Req() req: AuthenticatedRequest) {
    await this.pairing.revokeActiveForeverCode(req.auth.userId);
    return { ok: true };
  }

  @Post('create')
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreatePairingDto) {
    return this.pairing.create(req.auth.userId, dto.durationSeconds);
  }

  // The core anti-brute-force control for the 6-digit code: a generous
  // limit would still leave ~1,000,000 possibilities practically
  // guessable over time, so this is deliberately tight relative to normal
  // API traffic — a real user redeems a code once, rarely more than a
  // handful of times if they mistype it.
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post('redeem')
  redeem(@Req() req: AuthenticatedRequest, @Body() dto: RedeemPairingDto) {
    return this.pairing.redeem(req.auth.userId, dto.code);
  }

  @Delete(':id')
  async revoke(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.pairing.revoke(req.auth.userId, id);
    return { ok: true };
  }
}
