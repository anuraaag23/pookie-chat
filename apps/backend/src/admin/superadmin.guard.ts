import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AdminAuthenticatedRequest } from './admin.guard';

@Injectable()
export class SuperadminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AdminAuthenticatedRequest>();
    if (!req.adminUser || req.adminUser.role !== 'SUPERADMIN') {
      throw new ForbiddenException('Superadmin privileges required.');
    }
    return true;
  }
}
