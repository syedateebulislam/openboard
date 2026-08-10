/**
 * DeployVerificationService — post-deploy health check.
 *
 * "Deployed ✓" is only trustworthy if the live URL actually serves the app.
 * Verifies, with retries for CDN propagation:
 *  1. GET <url> returns 2xx HTML containing the app root (not a blank error page).
 *  2. GET <url>/api/auth responds with JSON (401 unauthenticated is the
 *     healthy answer; 404/5xx means the serverless API did not deploy).
 */

export interface VerificationResult {
  success: boolean;
  error?: string;
  /**
   * The URL is behind Vercel Deployment Protection, so the health check could
   * not reach the app at all — this is not a verdict on the deployment.
   */
  protected?: boolean;
}

/**
 * Whether a response is Vercel's authentication wall rather than the app.
 *
 * With Deployment Protection enabled, a deployment-specific URL serves an SSO
 * challenge to anyone unauthenticated. It answers 200 with a real HTML page, so
 * the app-root check failed and the deploy was reported as unhealthy — three
 * times, with a scary warning, for a deployment that was completely fine.
 *
 * Matched on the SSO markers rather than the status code, because the challenge
 * is served as 200 as often as 401.
 */
export function isProtectionChallenge(res: Response, body: string): boolean {
  if (res.status === 401) return true;
  // `redirect: 'follow'` lands us on Vercel's SSO host when it bounces.
  try {
    const landed = new URL(res.url);
    if (/(^|\.)vercel\.com$/.test(landed.hostname)) return true;
  } catch {
    // A malformed res.url is not evidence either way.
  }
  return /_vercel_sso_nonce|Authentication Required|Vercel Authentication/i.test(body);
}

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export class DeployVerificationService {
  static async verify(
    deployUrl: string,
    onProgress?: (line: string) => void,
    /** Overridden in tests so the retry path does not really wait 10 seconds. */
    retryDelayMs: number = RETRY_DELAY_MS,
  ): Promise<VerificationResult> {
    const base = deployUrl.replace(/\/+$/, '');
    let lastError = 'unknown';

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      onProgress?.(`Verifying deployment (attempt ${attempt}/${ATTEMPTS}): ${base}`);
      const result = await DeployVerificationService.check(base);
      if (result.success) {
        onProgress?.('Deployment verified: app shell and auth API are responding.');
        return result;
      }
      // Retrying a protection challenge is pointless — it will answer the same
      // way for as long as protection is on — and three rounds of "not healthy
      // yet" read as a failing deployment.
      if (result.protected) {
        onProgress?.('Deployment is protected by Vercel Authentication — skipped the health check.');
        onProgress?.('  Open the URL in a browser to confirm, or turn protection off for this project.');
        return result;
      }
      lastError = result.error ?? 'unknown';
      onProgress?.(`  Not healthy yet: ${lastError}`);
      if (attempt < ATTEMPTS) await delay(retryDelayMs);
    }

    return {
      success: false,
      error: `Deployment verification failed after ${ATTEMPTS} attempts: ${lastError}`,
    };
  }

  private static async check(base: string): Promise<VerificationResult> {
    // 1. App shell
    try {
      const res = await fetchWithTimeout(base);
      const html = res.ok ? await res.text() : '';
      // Checked before the status and the root-element test: a protection
      // challenge is a real page with a real status, and neither of those
      // checks can tell it apart from a broken deploy.
      if (isProtectionChallenge(res, html)) {
        return {
          success: false,
          protected: true,
          error: 'the deployment is behind Vercel Deployment Protection, so it cannot be checked from here',
        };
      }
      if (!res.ok) {
        return { success: false, error: `GET / returned HTTP ${res.status}` };
      }
      if (!/<div\s+id=["']root["']/.test(html)) {
        return { success: false, error: 'GET / returned a page without the app root element' };
      }
    } catch (err: any) {
      return { success: false, error: `GET / failed: ${err.message}` };
    }

    // 2. Auth API — 401 is the healthy unauthenticated response.
    try {
      const res = await fetchWithTimeout(`${base}/api/auth`);
      if (res.status !== 200 && res.status !== 401) {
        return { success: false, error: `GET /api/auth returned HTTP ${res.status} (expected 200 or 401)` };
      }
      const body = await res.json().catch(() => undefined);
      if (!body || typeof body !== 'object') {
        return { success: false, error: 'GET /api/auth did not return JSON' };
      }
    } catch (err: any) {
      return { success: false, error: `GET /api/auth failed: ${err.message}` };
    }

    return { success: true };
  }
}

export default DeployVerificationService;
