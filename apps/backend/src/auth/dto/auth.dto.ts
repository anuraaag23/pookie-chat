import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsUsername } from '../../domain/username';
import { normalizeEmail, IsEmailAddress } from '../../domain/email';

// trim + lowercase before validation ever sees the value — normalizing
// here (once, via the DTO's transform pipeline) rather than in every
// caller means AuthService, and anything else that reads dto.username,
// always sees the already-normalized form. See domain/username.ts for
// why trim/lowercase are the only transforms applied (an invalid
// character like "@" or a space is never stripped, only rejected).
function normalizeUsernameInput({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

function normalizeEmailInput({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? normalizeEmail(value) : value;
}

export class DeviceKeyFields {
  @IsString()
  @MaxLength(200)
  identityDhPublic!: string;

  @IsString()
  @MaxLength(200)
  identitySigningPublic!: string;

  @IsString()
  @MaxLength(200)
  signedPrekeyPublic!: string;

  @IsString()
  @MaxLength(200)
  signedPrekeySignature!: string;

  // Bounded on both axes — array size and per-element length — so a
  // malicious or buggy client can't smuggle an unbounded payload through
  // the one field here with no natural size limit (createMany would
  // otherwise happily insert however many rows an attacker cared to
  // send). 100 is far above any real client's real prekey batch (a
  // handful to a few dozen, replenished periodically) but well short of
  // being a meaningful DoS vector.
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  oneTimePrekeysPublic!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;

  @IsIn(['web', 'android'])
  platform!: 'web' | 'android';
}

export class RegisterDto extends DeviceKeyFields {
  // Deliberately no min-length ceiling beyond what's reasonable to accept
  // over HTTP; the real strength requirement is enforced by cost, not by
  // character-class rules that just push people toward predictable
  // patterns. 8 is a floor, not a target.
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password!: string;

  // Required for every new registration (see domain/username.ts for the
  // full policy). Uniqueness itself is enforced by the DB's unique
  // constraint at write time in AuthService.register — this decorator
  // only checks shape/format, since a shape check here can't see
  // concurrent registrations.
  @Transform(normalizeUsernameInput)
  @IsUsername()
  username!: string;

  // Real email identity for Stage 1 authentication. Required on registration.
  // Normalized via trim + lowercase.
  @Transform(normalizeEmailInput)
  @IsEmailAddress()
  email!: string;

  @IsOptional()
  @IsString()
  turnstileToken?: string;
}

export class VerifyEmailDto {
  @Transform(normalizeEmailInput)
  @IsEmailAddress()
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(6)
  code!: string;
}

export class ResendVerificationDto {
  @Transform(normalizeEmailInput)
  @IsEmailAddress()
  email!: string;
}

export class AddEmailDto {
  @Transform(normalizeEmailInput)
  @IsEmailAddress()
  email!: string;
}

/** GET /api/auth/username-availability?username=... — pre-registration only, unauthenticated. */
export class UsernameAvailabilityDto {
  @Transform(normalizeUsernameInput)
  @IsUsername()
  username!: string;
}

export class LoginDto extends DeviceKeyFields {
  @IsOptional()
  @IsString()
  identifier?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsString()
  password!: string;

  @IsOptional()
  @IsString()
  turnstileToken?: string;
}

/**
 * PATCH /api/auth/password. currentPassword is never optional and is
 * verified server-side against the stored hash before anything changes
 * (see AuthService.changePassword) — this DTO only checks shape; it has
 * no way to know whether currentPassword is actually correct, and never
 * pretends to.
 */
export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  // Same floor as RegisterDto.password — one place both could eventually
  // share, but duplicated for now rather than adding a shared base class
  // for two fields (see this file's other duplication-vs-import notes).
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  newPassword!: string;
}

/**
 * PATCH /api/auth/username. Only the shape is checked here — whether
 * this is actually the person's own account (it always is: userId comes
 * from the access-token guard, never the body), whether the 365-day
 * cooldown has elapsed, and whether the name is actually free are all
 * decided in AuthService.changeUsername, none of which a DTO can know.
 */
export class ChangeUsernameDto {
  @Transform(normalizeUsernameInput)
  @IsUsername()
  username!: string;
}

export class GoogleAuthExchangeDto extends DeviceKeyFields {
  @IsString()
  ticket!: string;

  @IsOptional()
  @IsString()
  username?: string;
}

export class GoogleTokenDto extends DeviceKeyFields {
  @IsString()
  idToken!: string;

  @IsOptional()
  @IsString()
  username?: string;
}

export class VerifyPasswordDto {
  @IsString()
  password!: string;
}

