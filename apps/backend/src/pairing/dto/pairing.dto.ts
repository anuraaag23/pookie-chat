import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

// The preset buttons the frontend shows (docs/02-DATABASE-SCHEMA.md /
// docs/04-DESIGN-SYSTEM.md) — kept here as the source of truth for what
// "the presets" are, even though the API also accepts any custom value
// within the Min/Max bounds below for the "Custom duration" option.
export const PAIRING_DURATION_PRESETS_SECONDS = [
  5 * 60,
  15 * 60,
  30 * 60,
  60 * 60,
  6 * 60 * 60,
  12 * 60 * 60,
  24 * 60 * 60,
  7 * 24 * 60 * 60,
] as const;

export class CreatePairingDto {
  // null = "Forever". A custom duration is accepted as a raw integer of
  // seconds (bounded below) rather than one of the preset buttons — both
  // paths converge on the same expiry computation either way.
  @IsOptional()
  @IsInt()
  @Min(60) // a code shorter-lived than a minute isn't usefully shareable
  @Max(365 * 24 * 60 * 60)
  durationSeconds?: number | null;
}

export class RedeemPairingDto {
  @IsString()
  @Length(6, 32)
  code!: string;
}
