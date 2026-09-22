import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class SendMessageDto {
  @IsUUID()
  conversationId!: string;

  @IsUUID()
  clientMessageId!: string;

  // Ciphertext + nonce only — there is intentionally no field this DTO
  // could carry that would ever hold plaintext. Bounded well above any
  // real text message (attachments go through their own 25MB-capped
  // upload flow, not this field) so a client can't smuggle an arbitrarily
  // large body through the one DTO field with no natural size limit.
  @IsString()
  @MaxLength(65536)
  ciphertext!: string;

  // AES-GCM IV is always 12 raw bytes = 16 base64 chars; this leaves
  // generous headroom without leaving the field unbounded.
  @IsString()
  @MaxLength(32)
  iv!: string;

  @IsIn(['TEXT', 'IMAGE', 'FILE'])
  messageType!: 'TEXT' | 'IMAGE' | 'FILE';

  @IsOptional()
  @IsUUID()
  replyToMessageId?: string;

  @IsOptional()
  @IsUUID()
  attachmentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  encryptedDek?: string;

  // SECURITY AUDIT F4 HARDENING: The sender's locally cached ratchet
  // session is tagged with the conversation epoch it was derived from
  // (see domain/sessionEpoch.ts). sessionEpoch is required: the server
  // refuses to accept ciphertext without an epoch or encrypted under a
  // session that's since been superseded by a burn+re-pair.
  @IsInt()
  sessionEpoch!: number;
}

export class SyncQueryDto {
  @IsUUID()
  conversationId!: string;

  // Query params arrive as strings; @Type coerces before @IsInt runs,
  // otherwise this always fails validation on the string "0".
  @Type(() => Number)
  @IsInt()
  @Min(0)
  after!: number;
}
