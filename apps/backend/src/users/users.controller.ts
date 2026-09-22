import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UsersService } from './users.service';
import { SearchUsernameDto } from './dto/users.dto';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';

@UseGuards(AccessTokenGuard)
@Controller('api/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // Exact-match lookup whose entire purpose is testing guesses against
  // real usernames — same treatment as pairing-code redemption
  // (PairingController): a stricter limit than the global 100/min
  // default, on top of authentication already being required.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('search')
  search(@Req() req: AuthenticatedRequest, @Query() dto: SearchUsernameDto) {
    return this.users.searchByUsername(req.auth.userId, dto.username);
  }
}
