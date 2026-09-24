export interface TemporaryDurationPreset {
  label: string;
  seconds: number;
  description: string;
}

// Temporary Code Durations: Restored original (15m, 1h, 1d, 7d) + additions (30d, 90d)
export const TEMPORARY_DURATIONS: TemporaryDurationPreset[] = [
  { label: '15m', seconds: 15 * 60, description: 'Expires automatically after 15 minutes.' },
  { label: '1h', seconds: 60 * 60, description: 'Expires automatically after 1 hour.' },
  { label: '1d', seconds: 24 * 60 * 60, description: 'Expires automatically after 1 day.' },
  { label: '7d', seconds: 7 * 24 * 60 * 60, description: 'Expires automatically after 7 days.' },
  { label: '30d', seconds: 30 * 24 * 60 * 60, description: 'Expires automatically after 30 days.' },
  { label: '90d', seconds: 90 * 24 * 60 * 60, description: 'Expires automatically after 90 days.' },
];
