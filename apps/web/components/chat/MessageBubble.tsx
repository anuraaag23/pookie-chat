import { NeoSurface } from '../ui/NeoSurface';

type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface QuotedReply {
  senderUsername?: string;
  text: string;
  messageId?: string;
}

interface MessageBubbleProps {
  id?: string;
  text: string;
  direction: 'sent' | 'received';
  timestamp?: string;
  status?: MessageStatus;
  replyTo?: QuotedReply;
  onReplyClick?: (messageId: string) => void;
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
 * A single message bubble with responsive max width, word wrapping,
 * text overflow prevention, and quoted reply rendering.
 */
export function MessageBubble({
  id,
  text,
  direction,
  timestamp,
  status,
  replyTo,
  onReplyClick,
}: MessageBubbleProps) {
  const isSent = direction === 'sent';

  return (
    <NeoSurface
      id={id ? `msg-${id}` : undefined}
      variant="raised"
      className={[
        'max-w-[85%] sm:max-w-[75%] min-w-0 px-4 py-2.5 text-sm leading-relaxed overflow-hidden transition-colors',
        isSent ? 'self-end rounded-br-md bg-surface-2' : 'self-start rounded-bl-md',
      ].join(' ')}
    >
      {/* Quoted Reply Box */}
      {replyTo && (
        <div
          onClick={(e) => {
            if (replyTo.messageId && onReplyClick) {
              e.stopPropagation();
              onReplyClick(replyTo.messageId);
            }
          }}
          className={`mb-2 p-2 rounded-lg border-l-2 border-info bg-surface-3/70 text-xs text-left min-w-0 transition-colors ${
            replyTo.messageId && onReplyClick ? 'cursor-pointer hover:bg-surface-3' : ''
          }`}
          title={replyTo.messageId && onReplyClick ? 'Click to view original message' : undefined}
        >
          <div className="font-bold text-[11px] text-info truncate">
            {replyTo.senderUsername ? `@${replyTo.senderUsername}` : 'Replied message'}
          </div>
          <div className="text-[11px] text-ink-dim truncate mt-0.5 break-words [overflow-wrap:anywhere]">
            {replyTo.text}
          </div>
        </div>
      )}

      {/* Message Text with Text Overflow & Anywhere Wrapping */}
      <div className="break-words [overflow-wrap:anywhere] whitespace-pre-wrap min-w-0 text-ink">
        {text}
      </div>

      {/* Timestamp & Status Indicator */}
      {(timestamp || status) && (
        <div className="mt-1 flex items-center justify-end gap-1 text-[10.5px] text-ink-dim shrink-0">
          {timestamp}
          {status === 'read' && <ReadTicks />}
          {status === 'failed' && <span className="text-danger font-medium">Failed to send</span>}
        </div>
      )}
    </NeoSurface>
  );
}
