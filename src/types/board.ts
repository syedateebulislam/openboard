/**
 * Board type definitions for OpenBoard.
 * Represents a generated analytics dashboard project.
 */

// ─── Phase 4: Chat & Board Config Types ─────────────────────────────────────

export interface BoardConfig {
  id: string;
  name: string;
  title: string;
  type: 'health' | 'finance' | 'grocery' | 'custom';
  outputDir: string;
  dataFiles: string[];
  githubRepo?: string;
  vercelProjectId?: string;
  deployUrl?: string;
  lastDeployed?: string;
  components: string[]; // list of generated component names
  createdAt: string;
  generatedAt?: string;
  dataSummary?: string; // data analysis summary for LLM context
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

// ─── Legacy Board Types ───────────────────────────────────────────────────────

export type BoardType =
  | 'finance'
  | 'health'
  | 'ecommerce'
  | 'analytics'
  | 'iot'
  | 'marketing'
  | 'custom';

export type BoardStatus =
  | 'draft'
  | 'generating'
  | 'generated'
  | 'building'
  | 'built'
  | 'deploying'
  | 'deployed'
  | 'error';

export interface DataSchema {
  columns: ColumnDefinition[];
  rowCount?: number;
  sampleRows?: Record<string, unknown>[];
}

export interface ColumnDefinition {
  name: string;
  type: 'string' | 'number' | 'date' | 'boolean' | 'unknown';
  nullable?: boolean;
  sampleValues?: unknown[];
}

export interface Board {
  /** Unique board identifier (slug-format, e.g., "my-finance-board") */
  name: string;
  /** Human-readable title (e.g., "My Finance Dashboard") */
  title: string;
  /** Board category for template selection */
  type: BoardType;
  /** Absolute path to the CSV data file */
  dataPath?: string;
  /** Absolute path to the generated project output directory */
  outputDir?: string;
  /** Current lifecycle status */
  status: BoardStatus;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last modified timestamp */
  updatedAt?: string;
  /** Deployed URL after successful deployment */
  deployedUrl?: string;
  /** Parsed data schema information */
  dataSchema?: DataSchema;
  /** Error message if status is 'error' */
  errorMessage?: string;
}

export interface CreateBoardOptions {
  name: string;
  title: string;
  type: BoardType;
  dataPath?: string;
  outputDir?: string;
}

export interface BoardPreset {
  type: BoardType;
  label: string;
  description: string;
  defaultTitle: string;
  suggestedCharts: string[];
  suggestedMetrics: string[];
}
