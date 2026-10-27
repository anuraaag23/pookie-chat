import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Request } from 'express';

export interface AdminAuthenticatedRequest extends Request {
  auth: { userId: string; deviceId: string };
  adminUser: {
    id: string;
    username: string;
    email: string | null;
    role: 'USER' | 'ADMIN' | 'SUPERADMIN';
    status: 'ACTIVE' | 'DELETED';
  };
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    if (!req.auth?.userId) {
      throw new UnauthorizedException();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: req.auth.userId },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        lockedUntil: true,
      },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new ForbiddenException('Account is not active.');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException('Account is currently locked.');
    }

    if (user.role !== 'ADMIN' && user.role !== 'SUPERADMIN') {
      throw new ForbiddenException('Administrative privileges required.');
    }

    req.adminUser = user;
    return true;
  }
}
