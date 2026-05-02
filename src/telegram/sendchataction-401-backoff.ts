import { computeBackoff, type BackoffPolicy } from "../infra/backoff.js";

export type TelegramSendChatActionLogger = (message: string) => void;

type ChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "find_location"
  | "record_video_note"
  | "upload_video_note"
  | "choose_sticker";

type SendChatActionFn = (
  chatId: number | string,
  action: ChatAction,
  threadParams?: unknown,
) => Promise<unknown>;

export type TelegramSendChatActionHandler = {
  /**
   * Send a chat action with automatic 401 backoff and circuit breaker.
   * Safe to call from multiple concurrent message contexts.
   */
  sendChatAction: (
    chatId: number | string,
    action: ChatAction,
    threadParams?: unknown,
  ) => Promise<void>;
  isSuspended: () => boolean;
  reset: () => void;
};

export type CreateTelegramSendChatActionHandlerParams = {
  sendChatActionFn: SendChatActionFn;
  logger: TelegramSendChatActionLogger;
  maxConsecutive401?: number;
};

const BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 1000,
  maxMs: 300_000, // 5 minutes
  factor: 2,
  jitter: 0.1,
};

function is401Error(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return message.includes("401") || message.toLowerCase().includes("unauthorized");
}

/**
 * Creates a GLOBAL (per-account) handler for sendChatAction that tracks 401 errors
 * across all message contexts. This prevents the infinite loop that caused Telegram
 * to delete bots (issue #27092).
 *
 * When a 401 occurs, a backoff deadline is recorded. Calls during the backoff window
 * return immediately (skip) instead of sleeping — this avoids blocking message
 * delivery pipelines that await the typing indicator before sending reply text.
 *
 * After maxConsecutive401 failures (default 10), all sendChatAction calls are
 * suspended until reset() is called.
 */
export function createTelegramSendChatActionHandler({
  sendChatActionFn,
  logger,
  maxConsecutive401 = 10,
}: CreateTelegramSendChatActionHandlerParams): TelegramSendChatActionHandler {
  let consecutive401Failures = 0;
  let suspended = false;
  // Timestamp (ms) before which we skip sendChatAction to respect the backoff window.
  let retryAfterMs = 0;

  const reset = () => {
    consecutive401Failures = 0;
    suspended = false;
    retryAfterMs = 0;
  };

  const sendChatAction = async (
    chatId: number | string,
    action: ChatAction,
    threadParams?: unknown,
  ): Promise<void> => {
    if (suspended) {
      return;
    }

    // Skip immediately during backoff window — never sleep here, as this function
    // is awaited in the message delivery path (startTypingOnText → onReplyStart).
    // Sleeping would block delivery of the first reply chunk for the full backoff duration.
    if (consecutive401Failures > 0) {
      const now = Date.now();
      if (now < retryAfterMs) {
        logger(
          `sendChatAction skipped: in backoff window for ${Math.ceil((retryAfterMs - now) / 1000)}s ` +
            `(failure ${consecutive401Failures}/${maxConsecutive401})`,
        );
        return;
      }
    }

    try {
      await sendChatActionFn(chatId, action, threadParams);
      // Success: reset failure counter
      if (consecutive401Failures > 0) {
        logger(`sendChatAction recovered after ${consecutive401Failures} consecutive 401 failures`);
        consecutive401Failures = 0;
        retryAfterMs = 0;
      }
    } catch (error) {
      if (is401Error(error)) {
        consecutive401Failures++;
        const backoffMs = computeBackoff(BACKOFF_POLICY, consecutive401Failures);
        retryAfterMs = Date.now() + backoffMs;

        if (consecutive401Failures >= maxConsecutive401) {
          suspended = true;
          logger(
            `CRITICAL: sendChatAction suspended after ${consecutive401Failures} consecutive 401 errors. ` +
              `Bot token is likely invalid. Telegram may DELETE the bot if requests continue. ` +
              `Replace the token and restart: openclaw channels restart telegram`,
          );
        } else {
          logger(
            `sendChatAction 401 error (${consecutive401Failures}/${maxConsecutive401}). ` +
              `Skipping for ${Math.ceil(backoffMs / 1000)}s (backoff window).`,
          );
        }
      }
      throw error;
    }
  };

  return {
    sendChatAction,
    isSuspended: () => suspended,
    reset,
  };
}
