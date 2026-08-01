/**
 * billerStudioFlow — the Biller Studio's decision logic, with no React in it.
 *
 * Deciding what a keystroke means is the part worth testing exhaustively: it is
 * what stops a real receipt being sent to an LLM before the user agreed, and it
 * is exactly the part that is awkward to reach through a rendered TUI. Keeping
 * it pure means those rules are asserted directly rather than inferred from a
 * terminal frame.
 *
 * The screen owns the effects; this owns the choices.
 */

export type StudioStage =
  | 'sender'
  | 'subject'
  | 'working'
  | 'confirm-send'
  | 'confirm-fields'
  | 'done';

export type StudioAction =
  | { type: 'noop' }
  | { type: 'leave' }
  | { type: 'help' }
  | { type: 'restart' }
  | { type: 'show-fields' }
  | { type: 'show-script' }
  | { type: 'reprobe' }
  | { type: 'reject-sender'; message: string }
  | { type: 'accept-sender'; sender: string }
  | { type: 'accept-subject'; subject: string }
  | { type: 'send-sample' }
  | { type: 'decline-sample' }
  | { type: 'build' }
  | { type: 'decline-build' }
  | { type: 'idle-hint' };

/** Deliberately loose — Gmail accepts far more than a strict RFC 5322 subset. */
export const SENDER_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The sentinel that means "every email from this sender". */
export const MATCH_ALL_SUBJECT = '-';

export function isAffirmative(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return lower === 'yes' || lower === 'y';
}

/**
 * Decide what a submitted line means.
 *
 * `busy` is handled by the caller: while an async stage runs the input is
 * ignored entirely, so no stage here has to defend against re-entry.
 */
export function nextStudioAction(stage: StudioStage, raw: string): StudioAction {
  const text = raw.trim();
  if (!text) return { type: 'noop' };

  const lower = text.toLowerCase();

  // Commands win everywhere, so there is always a way out of a stuck stage.
  switch (lower) {
    case '/cancel': return { type: 'leave' };
    case '/help': return { type: 'help' };
    case '/restart': return { type: 'restart' };
    case '/fields': return { type: 'show-fields' };
    case '/script': return { type: 'show-script' };
    case '/probe': return { type: 'reprobe' };
    default: break;
  }

  switch (stage) {
    case 'sender':
      return SENDER_PATTERN.test(text)
        ? { type: 'accept-sender', sender: text }
        : {
            type: 'reject-sender',
            message: `"${text}" is not an email address. Try something like noreply@bigbasket.com.`,
          };

    case 'subject':
      return { type: 'accept-subject', subject: text === MATCH_ALL_SUBJECT ? '' : text };

    // Anything that is not an explicit yes cancels. Silence, a typo, or a
    // stray keypress must never be read as consent to transmit the email.
    case 'confirm-send':
      return isAffirmative(text) ? { type: 'send-sample' } : { type: 'decline-sample' };

    case 'confirm-fields':
      return isAffirmative(text) ? { type: 'build' } : { type: 'decline-build' };

    case 'working':
    case 'done':
    default:
      return { type: 'idle-hint' };
  }
}
