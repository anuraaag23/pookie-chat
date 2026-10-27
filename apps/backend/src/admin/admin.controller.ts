import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AdminGuard, AdminAuthenticatedRequest } from './admin.guard';
import { SuperadminGuard } from './superadmin.guard';
import { AdminService } from './admin.service';
import {
  AuditLogsQueryDto,
  BootstrapAdminDto,
  MaintenanceSweepDto,
  RoomsQueryDto,
  SecurityEventsQueryDto,
  UpdateRoomDto,
  UpdateUserRoleDto,
  UpdateUserStatusDto,
  UserQueryDto,
} from './dto/admin.dto';

function getClientIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0];
    return first ? first.trim() : undefined;
  }
  return req.ip;
}

@Controller('api/admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * Bootstraps an initial Superadmin account using a server-side secret key.
   * Throttled to 5 attempts/min to protect against brute force.
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('bootstrap')
  async bootstrap(@Req() req: Request, @Body() dto: BootstrapAdminDto) {
    return this.adminService.bootstrapAdmin(dto, getClientIp(req));
  }

  /**
   * Platform Overview & Realtime Health Metrics
   */
  @UseGuards(AccessTokenGuard, AdminGuard)
  @Get('metrics')
  async getMetrics() {
    return this.adminService.getMetrics();
  }

  /**
   * User Management
   */
  @UseGuards(AccessTokenGuard, AdminGuard)
  @Get('users')
  async getUsers(@Query() query: UserQueryDto) {
    return this.adminService.getUsers(query);
  }

  @UseGuards(AccessTokenGuard, AdminGuard)
  @Get('users/:id')
  async getUserDetail(@Param('id') userId: string) {
    return this.adminService.getUserDetail(userId);
  }

  @UseGuards(AccessTokenGuard, AdminGuard)
  @Patch('users/:id/status')
  async updateUserStatus(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') userId: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(req.adminUser.id, userId, dto, getClientIp(req));
  }

  @UseGuards(AccessTokenGuard, AdminGuard)
  @Post('users/:id/unlock')
  async unlockUser(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') userId: string,
  ) {
    return this.adminService.unlockUser(req.adminUser.id, userId, getClientIp(req));
  }

  @UseGuards(AccessTokenGuard, AdminGuard)
  @Post('users/:id/revoke-sessions')
  async revokeUserSessions(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') userId: string,
  ) {
    return this.adminService.revokeUserSessions(req.adminUser.id, userId, getClientIp(req));
  }

  /**
   * Role assignment - restricted strictly to Superadmins
   */
  @UseGuards(AccessTokenGuard, AdminGuard, SuperadminGuard)
  @Patch('users/:id/role')
  async updateUserRole(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') userId: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.adminService.updateUserRole(req.adminUser.id, userId, dto, getClientIp(req));
  }

  /**
   * Group Chat Communities Moderation
   */
  @UseGuards(AccessTokenGuard, AdminGuard)
  @Get('rooms')
  async getRooms(@Query() query: RoomsQueryDto) {
    return this.adminService.getRooms(query);
  }

  @UseGuards(AccessTokenGuard, AdminGuard)
  @Get('rooms/:id')
  async getRoomDetail(@Param('id') roomId: string) {
    return this.adminService.getRoomDetail(roomId);
  }

  @UseGuards(AccessTokenGuard, AdminGuard)
  @Patch('rooms/:id')
  async updateRoom(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') roomId: string,
    @Body() dto: UpdateRoomDto,
  ) {
    return this.adminService.updateRoom(req.adminUser.id, roomId, dto, getClientIp(req));
  }

  /**
   * Security Events & Audit Trail
   */
  @UseGuards(AccessTokenGuard, AdminGuard)
  @Get('security/events')
  async getSecurityEvents(@Query() query: SecurityEventsQueryDto) {
    return this.adminService.getSecurityEvents(query);
  }

  @UseGuards(AccessTokenGuard, AdminGuard)
  @Get('security/audit-logs')
  async getAuditLogs(@Query() query: AuditLogsQueryDto) {
    return this.adminService.getAuditLogs(query);
  }

  /**
   * System Maintenance & Expired Data Cleanup Sweep Trigger
   */
  @UseGuards(AccessTokenGuard, AdminGuard)
  @Post('system/sweep')
  async triggerSweep(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: MaintenanceSweepDto,
  ) {
    return this.adminService.triggerSweep(req.adminUser.id, dto.type, getClientIp(req));
  }
}
