import { NeoSurface } from '../ui/NeoSurface';
import { LinkPreviewCard } from './LinkPreviewCard';

type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'queued';

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
  onDismiss?: () => void;
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
      className="h-[13px] w-[13px] text-info transition-colors duration-200"
      aria-label="Read"
    >
      <path d="M1 12l5 5L17 6" />
      <path d="M7 12l5 5L23 6" />
    </svg>
  );
}

function DeliveredTicks() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[13px] w-[13px] text-ink-dim transition-colors duration-200"
      aria-label="Delivered"
    >
      <path d="M1 12l5 5L17 6" />
      <path d="M7 12l5 5L23 6" />
    </svg>
  );
}

function SentTick() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[13px] w-[13px] text-ink-dim transition-colors duration-200"
      aria-label="Sent"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

export function MessageStatusTicks({ status }: { status?: string }) {
  if (!status) return null;
  if (status === 'read') return <ReadTicks />;
  if (status === 'delivered') return <DeliveredTicks />;
  if (status === 'sent') return <SentTick />;
  return null;
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
  onDismiss,
}: MessageBubbleProps) {
  const isSent = direction === 'sent';

  return (
    <NeoSurface
      id={id ? `msg-${id}` : undefined}
      variant="raised"
      onCopy={(e) => {
        // Block native Ctrl+C / browser selection copy on protected message content (Issue #9)
        e.preventDefault();
      }}
      className={[
        'max-w-[85%] sm:max-w-[75%] min-w-0 px-4 py-2.5 text-sm leading-relaxed overflow-hidden transition-all duration-150 select-none msg-no-select animate-in fade-in slide-in-from-bottom-1',
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
      {text === '[Could not decrypt this message]' || text.startsWith('[Could not decrypt') ? (
        <div className="flex items-start justify-between gap-3 py-1 text-ink-dim select-text">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-amber-500/15 text-amber-500 flex items-center justify-center shrink-0 mt-0.5" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0110 0v4"/>
              </svg>
            </div>
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-xs font-semibold text-ink flex items-center gap-1.5">
                Could not decrypt this message
              </span>
              <span className="text-[11px] text-ink-dim leading-snug">
                Encrypted with a previous session key that is no longer on this device.
              </span>
            </div>
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss();
              }}
              className="text-[10px] text-ink-dim hover:text-danger font-semibold px-2 py-1 rounded-md bg-surface-3/80 hover:bg-surface-3 shrink-0 transition-colors cursor-pointer"
              title="Dismiss this undecryptable message from local storage"
            >
              Dismiss
            </button>
          )}
        </div>
      ) : (
        <div className="break-words [overflow-wrap:anywhere] whitespace-pre-wrap min-w-0 text-ink">
          {text}
        </div>
      )}

      {/* Zero-Knowledge Link Preview Card */}
      {!text.startsWith('{') && !text.startsWith('[Could not decrypt') && (() => {
        const urlMatch = text.match(/https?:\/\/[^\s<>'")]+/i);
        return urlMatch ? <LinkPreviewCard url={urlMatch[0]} /> : null;
      })()}

      {/* Timestamp & Status Indicator */}
      {(timestamp || status) && (
        <div className="mt-1 flex items-center justify-end gap-1 text-[10.5px] text-ink-dim shrink-0">
          {timestamp}
          {isSent && <MessageStatusTicks status={status} />}
          {status === 'queued' && (
            <span className="text-amber-500 font-medium flex items-center gap-1" title="Queued (Offline)">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 14 14" />
              </svg>
              Queued
            </span>
          )}
          {status === 'failed' && <span className="text-danger font-medium">Failed to send</span>}
        </div>
      )}
    </NeoSurface>
  );
}
