/**
 * Configuration type definitions for OpenBoardCLI.
 * These match the Zod schema in ConfigService.
 */

import type { LLMProviderName } from './llm.js';

export type LLMProvider = LLMProviderName;

export interface LLMConfig {
  provider?: LLMProvider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  ollamaHost?: string;
}

export interface GitHubConfig {
  token?: string;
  username?: string;
}

export interface VercelConfig {
  token?: string;
  teamId?: string;
}

export interface CredentialsConfig {
  username?: string;
  passwordHash?: string;
  jwtSecret?: string;
}

export interface BoardConfig {
  name: string;
  type?: string;
  dataPath?: string;
  outputDir?: string;
  createdAt?: string;
  deployedUrl?: string;
}

export interface AppConfig {
  llm?: LLMConfig;
  github?: GitHubConfig;
  vercel?: VercelConfig;
  credentials?: CredentialsConfig;
  boards?: BoardConfig[];
}
