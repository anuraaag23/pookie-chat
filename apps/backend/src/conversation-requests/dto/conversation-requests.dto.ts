import { IsString, Length } from 'class-validator';

export class CreateConversationRequestDto {
  @IsString()
  @Length(3, 30)
  targetUsername!: string;
}
