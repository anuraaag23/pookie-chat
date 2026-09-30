import { IsOptional, IsString, Length } from 'class-validator';

export class CreateConversationRequestDto {
  @IsOptional()
  @IsString()
  @Length(3, 30)
  targetUsername?: string;

  @IsOptional()
  @IsString()
  @Length(3, 30)
  recipientUsername?: string;
}

