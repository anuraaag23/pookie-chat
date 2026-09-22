import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { verifyAccessToken } from '../domain/tokens';
import { AppConfig } from '../config/env';
import { APP_CONFIG } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';

export interface AuthenticatedRequest extends Request {
  auth: { userId: string; deviceId: string };
}

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    const payload = verifyAccessToken(header.slice('Bearer '.length), this.config.accessTokenSecret);
    if (!payload) throw new UnauthorizedException();
    // Cryptographically valid and unexpired is not the same as still
    // authorized: this device may have been revoked (Settings → Devices,
    // or "log out all other devices") at any point in the token's
    // remaining lifetime. A single indexed lookup by primary key, not a
    // join or a scan — the correctness this buys (a revoked device's
    // token stops working on its very next request, not just once it
    // naturally expires) is worth the one query. See domain/tokens.ts's
    // header comment for the fuller trade-off.
    const device = await this.prisma.device.findUnique({ where: { id: payload.deviceId }, select: { revokedAt: true } });
    if (!device || device.revokedAt) throw new UnauthorizedException();
    // Every downstream handler reads the acting user/device from here —
    // never from a client-supplied body field. See docs/02-DATABASE-SCHEMA.md
    // and the "never trust client-provided sender IDs" requirement.
    req.auth = { userId: payload.userId, deviceId: payload.deviceId };
    return true;
  }
}
