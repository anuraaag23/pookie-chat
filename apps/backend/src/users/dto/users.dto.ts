import { Transform } from 'class-transformer';
import { IsUsername } from '../../domain/username';

function normalizeUsernameInput({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/** GET /api/users/search?username=... — authenticated, exact match only. */
export class SearchUsernameDto {
  @Transform(normalizeUsernameInput)
  @IsUsername()
  username!: string;
}
