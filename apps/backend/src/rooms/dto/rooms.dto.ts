import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { MessageType, RoomJoinPolicy } from '@prisma/client';

export class CreateRoomDto {
  @IsString()
  @Length(2, 50)
  name!: string;

  @IsInt()
  @Min(2)
  @Max(2000)
  maxMembers!: number;

  @IsEnum(RoomJoinPolicy)
  joinPolicy!: RoomJoinPolicy;

  @IsOptional()
  @IsString()
  openKeyCiphertext?: string;

  @IsOptional()
  @IsString()
  openKeyNonce?: string;
}

export class UpdateRoomDto {
  @IsOptional()
  @IsString()
  @Length(2, 50)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(2000)
  maxMembers?: number;

  @IsOptional()
  @IsEnum(RoomJoinPolicy)
  joinPolicy?: RoomJoinPolicy;

  @IsOptional()
  @IsString()
  openKeyCiphertext?: string;

  @IsOptional()
  @IsString()
  openKeyNonce?: string;
}

export class DeleteRoomDto {
  @IsOptional()
  @IsString()
  password?: string;
}

export class ListMembersQueryDto {
  @IsOptional()
  page?: string;

  @IsOptional()
  limit?: string;
}

export class JoinRoomDto {
  @IsString()
  @Length(6, 32)
  code!: string;
}

export class AcceptRequestDto {
  @IsOptional()
  @IsString()
  encryptedKey?: string;

  @IsOptional()
  @IsString()
  nonce?: string;
}

export class SendRoomMessageDto {
  @IsString()
  @Length(1, 128)
  clientMessageId!: string;

  @IsString()
  ciphertext!: string; // base64

  @IsString()
  iv!: string; // base64

  @IsOptional()
  @IsEnum(MessageType)
  messageType?: MessageType;

  @IsOptional()
  @IsString()
  replyToMessageId?: string;

  @IsOptional()
  @IsInt()
  keyEpoch?: number;
}

export class StoreKeyPackageDto {
  @IsString()
  recipientUserId!: string;

  @IsString()
  encryptedKey!: string;

  @IsString()
  nonce!: string;

  @IsOptional()
  @IsInt()
  keyEpoch?: number;
}
