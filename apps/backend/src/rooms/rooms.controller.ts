import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RoomsService } from './rooms.service';
import {
  CreateRoomDto,
  UpdateRoomDto,
  ListMembersQueryDto,
  JoinRoomDto,
  AcceptRequestDto,
  SendRoomMessageDto,
  StoreKeyPackageDto,
} from './dto/rooms.dto';

@Controller('api/rooms')
@UseGuards(AccessTokenGuard)
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateRoomDto) {
    return this.roomsService.create(req.auth.userId, dto);
  }

  @Get()
  async listUserRooms(@Req() req: AuthenticatedRequest) {
    return this.roomsService.listUserRooms(req.auth.userId);
  }

  @Post('join')
  async joinByCode(@Req() req: AuthenticatedRequest, @Body() dto: JoinRoomDto) {
    return this.roomsService.joinByCode(req.auth.userId, dto.code);
  }

  @Get(':id')
  async getRoom(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.roomsService.getRoom(req.auth.userId, id);
  }

  @Get(':id/members')
  async getMembers(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.roomsService.getMembers(
      req.auth.userId,
      id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Patch(':id')
  async updateRoom(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateRoomDto,
  ) {
    return this.roomsService.updateRoom(req.auth.userId, id, dto);
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ) {
    return this.roomsService.removeMember(req.auth.userId, id, targetUserId);
  }

  @Get(':id/requests')
  async getPendingRequests(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.roomsService.getPendingRequests(req.auth.userId, id);
  }

  @Post(':id/requests/:requestId/accept')
  async acceptRequest(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() dto: AcceptRequestDto,
  ) {
    return this.roomsService.acceptRequest(req.auth.userId, id, requestId, dto);
  }

  @Post(':id/requests/:requestId/reject')
  async rejectRequest(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
  ) {
    return this.roomsService.rejectRequest(req.auth.userId, id, requestId);
  }

  @Get(':id/messages')
  async listMessages(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.roomsService.listMessages(
      req.auth.userId,
      id,
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Post(':id/messages')
  async sendMessage(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SendRoomMessageDto,
  ) {
    return this.roomsService.sendMessage(req.auth.userId, id, dto);
  }

  @Post(':id/leave')
  async leaveRoom(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.roomsService.leaveRoom(req.auth.userId, id);
  }

  @Delete(':id')
  async deleteRoom(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.roomsService.deleteRoom(req.auth.userId, id);
  }

  @Post(':id/key-package')
  async storeKeyPackage(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: StoreKeyPackageDto,
  ) {
    return this.roomsService.storeKeyPackage(req.auth.userId, id, dto);
  }

  @Get(':id/key-package')
  async getKeyPackage(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('keyEpoch') keyEpoch?: string,
  ) {
    return this.roomsService.getKeyPackage(
      req.auth.userId,
      id,
      keyEpoch ? parseInt(keyEpoch, 10) : undefined,
    );
  }
}
