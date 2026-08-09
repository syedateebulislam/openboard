/**
 * Agent error codes — machine-readable failure classification for the
 * non-interactive CLI (`openboard agent ... --json`).
 *
 * Agents should branch on `errorCode`, never on the prose `error` string.
 * Codes are stable contract values documented in Agent.md.
 */

export type AgentErrorCode =
  | 'E_VALIDATION'          // missing/invalid CLI flags or options
  | 'E_DATA_NOT_FOUND'      // data source file missing or unreadable
  | 'E_DATA_PARSE'          // data source exists but could not be parsed
  | 'E_DASHBOARD_NOT_FOUND' // selector did not match a registered dashboard
  | 'E_NO_LLM'              // no LLM provider configured
  | 'E_LLM_QUOTA'           // LLM provider quota/credits/rate limit exhausted
  | 'E_LLM_EMPTY'           // LLM returned no writable files
  | 'E_LLM_FAILED'          // LLM call itself failed (auth, timeout, transport)
  | 'E_SCAFFOLD_FAILED'     // workspace scaffold failed
  | 'E_INSTALL_FAILED'      // npm install failed
  | 'E_BUILD_FAILED'        // vite build failed (after any repair attempts)
  | 'E_PUSH_FAILED'         // git commit/push failed
  | 'E_DEPLOY_AUTH'         // Vercel auth missing/invalid
  | 'E_DEPLOY_FAILED'       // Vercel deploy failed
  | 'E_VERIFY_FAILED'       // post-deploy verification failed
  | 'E_LOCKED'              // another OpenBoardCLI run holds the project lock
  | 'E_RUN_NOT_FOUND'       // resume: run id not found
  | 'E_UNKNOWN';

interface ErrorPattern {
  pattern: RegExp;
  code: AgentErrorCode;
}

/**
 * Signals that an LLM provider has run out of quota/credits or is rate limited.
 * Covers OpenAI (insufficient_quota / 429), Anthropic, Moonshot, and the Codex
 * CLI's retry-then-give-up output ("Reconnecting... N/5", "stream disconnected").
 */
const QUOTA_PATTERN =
  /insufficient_quota|exceeded your current quota|check your plan and billing|quota|credit balance|out of credits|usage limit|billing hard limit|too many requests|rate[ _-]?limit|429|Reconnecting\.\.\.|stream disconnected|overloaded/i;

/** True when an error message indicates LLM quota/credits/rate-limit exhaustion. */
export function isLLMQuotaError(error: string | undefined | null): boolean {
  return Boolean(error) && QUOTA_PATTERN.test(error!);
}

const AUTH_PATTERN = /invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key|authentication[ _-]?error|unauthorized|401/i;
const BAD_REQUEST_PATTERN = /does not support|unsupported (?:value|parameter)|400/i;
const CONNECTION_PATTERN = /ECONNREFUSED|connection refused|fetch failed|network error|ENOTFOUND|EAI_AGAIN/i;
const TIMEOUT_PATTERN = /timed? ?out|ETIMEDOUT|deadline exceeded/i;

/**
 * Content that *looks like* an error even though the provider returned it as a
 * successful completion — e.g. a local stub/proxy echoing an upstream failure,
 * or a gateway putting exception text in the assistant message body.
 */
export function isErrorShapedContent(text: string | undefined | null): boolean {
  if (!text) return false;
  const head = text.trim().slice(0, 300);
  return /^\[[\w.-]+\] upstream error:|^(?:[\w.]+\.)?[A-Z]\w*(?:Exception|Error):|^Error:\s|"type"\s*:\s*"error"/.test(head);
}

/**
 * Strip machine noise (exception class names, upstream-error wrappers) so the
 * remaining text explains the failure in the provider's own words.
 */
function stripErrorNoise(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^\[[\w.-]+\] upstream error:\s*/i, '');
  // Peel leading exception-class prefixes like `com.openai.errors.BadRequestException:`
  for (let i = 0; i < 3; i++) {
    text = text.replace(/^(?:[\w$]+\.)*[A-Z][\w$]*(?:Exception|Error):\s*/, '').replace(/^Error:\s*/, '');
  }
  const firstLine = text.split('\n')[0]?.trim();
  return firstLine || raw.trim();
}

/**
 * One funnel for user-facing LLM failure text. Always returns something a
 * person can act on — raw provider/exception text never reaches the user.
 */
export function describeLLMError(error: string | undefined | null, providerName?: string): string {
  const raw = (error ?? '').trim() || 'Unknown LLM error';
  const provider = providerName ? ` (${providerName})` : '';
  const cleaned = stripErrorNoise(raw);
  if (isLLMQuotaError(raw)) {
    return (
      `Your LLM quota or credits appear to be exhausted${provider}. ` +
      `The provider rejected the request after retrying. ` +
      `Check your plan usage/billing, wait for the limit to reset, or switch providers with /config — then try again.`
    );
  }
  if (AUTH_PATTERN.test(raw)) {
    return `The LLM provider${provider} rejected your API key. Re-enter it in Settings (or the setup wizard) and try again. Details: ${cleaned}`;
  }
  if (CONNECTION_PATTERN.test(raw)) {
    return `Could not reach the LLM provider${provider}. If you use a local server (Ollama/LM Studio), make sure it is running, then try again. Details: ${cleaned}`;
  }
  if (TIMEOUT_PATTERN.test(raw)) {
    // A timeout on a local server almost always means the model is simply slow
    // rather than that anything is wrong, and the answer was usually part-built
    // when the request was cut — so the advice differs from the hosted case.
    // Retrying an identical prompt at the same speed just repeats the wait.
    return (
      `The LLM request${provider} timed out before the model finished. ` +
      `A local model on modest hardware can take tens of minutes for one dashboard or fetcher; ` +
      `OpenBoardCLI now waits 45 minutes for a local server, so hitting this means the model is slower than that. ` +
      `Use a smaller/quantised model, or lower the UI quality to shorten the answer — retrying the same prompt will take just as long. ` +
      `Details: ${cleaned}`
    );
  }
  if (BAD_REQUEST_PATTERN.test(raw)) {
    return `The LLM provider${provider} rejected the request settings. The selected model may not support them — try a different model with /model. Details: ${cleaned}`;
  }
  return `Generation failed${provider}: ${cleaned}`;
}

// Order matters: first match wins, so more specific patterns come first.
const ERROR_PATTERNS: ErrorPattern[] = [
  { pattern: /^Missing required|^Invalid --|^Unknown agent action/i, code: 'E_VALIDATION' },
  { pattern: /Dashboard not found/i, code: 'E_DASHBOARD_NOT_FOUND' },
  { pattern: /Run not found/i, code: 'E_RUN_NOT_FOUND' },
  { pattern: /locked by another OpenBoardCLI run/i, code: 'E_LOCKED' },
  { pattern: /File not found|ENOENT|no such file/i, code: 'E_DATA_NOT_FOUND' },
  { pattern: /Unsupported (?:data|file) (?:format|type)|Failed to parse|parse error/i, code: 'E_DATA_PARSE' },
  { pattern: /No LLM provider configured/i, code: 'E_NO_LLM' },
  { pattern: QUOTA_PATTERN, code: 'E_LLM_QUOTA' },
  { pattern: /did not return any writable files|did not return an App\.tsx/i, code: 'E_LLM_EMPTY' },
  { pattern: /Scaffold failed/i, code: 'E_SCAFFOLD_FAILED' },
  { pattern: /Install failed/i, code: 'E_INSTALL_FAILED' },
  { pattern: /Build failed/i, code: 'E_BUILD_FAILED' },
  { pattern: /push (?:skipped\/)?failed|Git init failed|No changes to commit/i, code: 'E_PUSH_FAILED' },
  { pattern: /Vercel is not authenticated|No existing credentials|token is not valid|vercel login/i, code: 'E_DEPLOY_AUTH' },
  { pattern: /Deploy failed|Vercel link failed/i, code: 'E_DEPLOY_FAILED' },
  { pattern: /verification failed/i, code: 'E_VERIFY_FAILED' },
  { pattern: /codex|API key|rate limit|timed out|timeout/i, code: 'E_LLM_FAILED' },
];

/**
 * Classify a prose error message into a stable AgentErrorCode.
 * Returns E_UNKNOWN when no known pattern matches.
 */
export function classifyAgentError(error: string | undefined | null): AgentErrorCode {
  if (!error) return 'E_UNKNOWN';
  for (const { pattern, code } of ERROR_PATTERNS) {
    if (pattern.test(error)) return code;
  }
  return 'E_UNKNOWN';
}

export default classifyAgentError;
