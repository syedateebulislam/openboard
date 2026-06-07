/**
 * Prompt builder for Stage 3: Data helper generation.
 * Raw dashboard rows must stay server-side and be loaded through
 * useProtectedDashboardData(). This prompt only permits pure helper functions
 * over data passed in from the protected API response.
 */
export function buildDataProcessingPrompt(
  types: string,
  dataSummary: string,
  sampleRows: string,
  referenceData: string,
): string {
  return `Generate a TypeScript data helper module for protected dashboard data.

TypeScript Types:
${types}

Dataset Summary:
${dataSummary}

Sample Rows (schema examples only; do not embed them in output):
${sampleRows}

Reference pattern:
${referenceData}

Generate a complete data module that:
1. Imports the TypeScript types
2. Does NOT export or embed raw rows, sample rows, credentials, tokens, emails, phone numbers, or private source data
3. Exports pure helper functions (aggregations, filters) that accept rows as function parameters
4. Is safe to include in a frontend bundle because it contains no private dataset values
Return ONLY the file content.`;
}
