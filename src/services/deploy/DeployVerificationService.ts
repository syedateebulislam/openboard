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
      lastError = result.error ?? 'unknown';
      onProgress?.(`  Not healthy yet: ${lastError}`);
      if (attempt < ATTEMPTS) await delay(RETRY_DELAY_MS);
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
      if (!res.ok) {
        return { success: false, error: `GET / returned HTTP ${res.status}` };
      }
      const html = await res.text();
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
