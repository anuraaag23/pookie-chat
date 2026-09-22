import { NeoSurface } from '../ui/NeoSurface';

type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

interface MessageBubbleProps {
  text: string;
  direction: 'sent' | 'received';
  timestamp?: string;
  status?: MessageStatus;
}

function ReadTicks() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[13px] w-[13px] text-info"
      aria-label="Read"
    >
      <path d="M1 12l5 5L17 6" />
      <path d="M7 12l5 5L23 6" />
    </svg>
  );
}

/**
 * A single message bubble. Sent vs. received is carried by alignment and a
 * slightly different surface tone — deliberately not by color, which is
 * reserved for functional states only (docs/04-DESIGN-SYSTEM.md §1).
 */
export function MessageBubble({ text, direction, timestamp, status }: MessageBubbleProps) {
  const isSent = direction === 'sent';
  return (
    <NeoSurface
      variant="raised"
      className={[
        'max-w-[78%] px-4 py-2.5 text-sm leading-relaxed',
        isSent ? 'self-end rounded-br-md bg-surface-2' : 'self-start rounded-bl-md',
      ].join(' ')}
    >
      <div>{text}</div>
      {(timestamp || status) && (
        <div className="mt-1 flex items-center justify-end gap-1 text-[10.5px] text-ink-dim">
          {timestamp}
          {status === 'read' && <ReadTicks />}
          {status === 'failed' && <span className="text-danger">Failed to send</span>}
        </div>
      )}
    </NeoSurface>
  );
}
