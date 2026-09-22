import { Type } from 'class-transformer';
import { IsIn, IsInt, IsUUID, Min } from 'class-validator';

export class UploadQueryDto {
  @IsUUID()
  conversationId!: string;

  // Kept in sync with ALLOWED_MIME_HINTS in attachments.service.ts — the
  // service check stays too, since that's the actual enforcement point;
  // this just turns a garbage value into a clean 400 instead of a 500.
  @IsIn(['image', 'file'])
  mimeTypeHint!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  originalSize!: number;
}
