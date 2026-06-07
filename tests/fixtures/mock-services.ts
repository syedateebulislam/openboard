/**
 * ============================================================================
 * SHARED MOCK SERVICES
 * ============================================================================
 *
 * Centralized mock implementations for all external services. These mocks
 * prevent real API calls during testing while providing predictable responses.
 *
 * USAGE:
 *   Import specific mocks in test files and register them via vi.mock():
 *
 *   ```ts
 *   import { mockGitHubAPI } from '../fixtures/mock-services';
 *   vi.mock('../../src/services/github/GitHubService', () => mockGitHubAPI);
 *   ```
 *
 * MOCK CATEGORIES:
 *   1. LLM Provider Mocks   - Simulated OpenAI, Anthropic, Ollama responses
 *   2. GitHub API Mocks      - Repo creation, push simulation
 *   3. Vercel API Mocks      - Project creation, deployment simulation
 *   4. Build Service Mocks   - Simulated tsc + vite build results
 *   5. Config Service Mocks  - In-memory config store
 *
 * IMPORTANT:
 *   - Mocks return valid-shaped data matching real API responses
 *   - Use `mockReset()` between tests to prevent state leakage
 *   - LLM mocks return deterministic code strings (not random)
 * ============================================================================
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// 1. LLM PROVIDER MOCKS
// ---------------------------------------------------------------------------

/**
 * Mock LLM response for type generation (Stage 2).
 * Returns a valid TypeScript interface file content.
 */
export const MOCK_LLM_TYPE_GENERATION = `
export interface TransactionRecord {
  date: string;
  amount: number;
  category: string;
  description: string;
  account: string;
  type: 'debit' | 'credit';
}

export interface MonthlySummary {
  month: string;
  totalIncome: number;
  totalExpenses: number;
  savingsRate: number;
}

export interface FinanceData {
  transactions: TransactionRecord[];
  monthlySummaries: MonthlySummary[];
}
`.trim();

/**
 * Mock LLM response for data module generation (Stage 3).
 * Returns a valid TypeScript data file with embedded data.
 */
export const MOCK_LLM_DATA_MODULE = `
import type { FinanceData, TransactionRecord, MonthlySummary } from '../types/finance';

const transactions: TransactionRecord[] = [
  { date: '2025-01-15', amount: -42.50, category: 'groceries', description: 'Whole Foods', account: 'checking', type: 'debit' },
  { date: '2025-01-15', amount: 5000, category: 'salary', description: 'Monthly Salary', account: 'checking', type: 'credit' },
];

export const financeData: FinanceData = {
  transactions,
  monthlySummaries: [],
};

export const summaryStats = {
  totalTransactions: transactions.length,
  totalIncome: 5000,
  totalExpenses: 42.50,
  savingsRate: 99.15,
};
`.trim();

/**
 * Mock LLM response for component generation (Stage 4).
 * Returns a valid React component with Recharts.
 */
export const MOCK_LLM_COMPONENT = `
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { DollarSign } from 'lucide-react';

const data = [
  { month: 'Jan', income: 5000, expenses: 1900 },
  { month: 'Feb', income: 5000, expenses: 260 },
];

export default function Overview() {
  return (
    <div className="dashboard">
      <div className="metrics-grid">
        <div className="metric-card">
          <DollarSign size={20} />
          <span className="metric-value">$10,000</span>
          <span className="metric-label">Total Income</span>
        </div>
      </div>
      <div className="chart-section">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data}>
            <CartesianGrid stroke="#374151" />
            <XAxis dataKey="month" />
            <YAxis />
            <Tooltip />
            <Bar dataKey="income" fill="#10b981" />
            <Bar dataKey="expenses" fill="#ef4444" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
`.trim();

/**
 * Mock LLM response for App.tsx generation (Stage 5).
 */
export const MOCK_LLM_APP_TSX = `
import { useState } from 'react';
import { AuthProvider, useAuth } from './components/AuthProvider';
import LoginPage from './components/LoginPage';
import Overview from './components/Overview';

function AppContent() {
  const [activeTab, setActiveTab] = useState('overview');
  const { isAuthenticated, login, logout } = useAuth();

  if (!isAuthenticated) return <LoginPage onLogin={login} />;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Finance Dashboard</h1>
        <nav className="main-nav">
          <button onClick={() => setActiveTab('overview')} className={activeTab === 'overview' ? 'active' : ''}>Overview</button>
        </nav>
        <button onClick={logout} className="logout-btn">Logout</button>
      </header>
      <main className="app-main">
        {activeTab === 'overview' && <Overview />}
      </main>
    </div>
  );
}

export default function App() {
  return <AuthProvider><AppContent /></AuthProvider>;
}
`.trim();

/**
 * Mock LLM streaming response generator.
 * Yields chunks that simulate real streaming behavior.
 */
export async function* mockLLMStream(fullResponse: string) {
  const words = fullResponse.split(' ');
  for (let i = 0; i < words.length; i++) {
    const text = (i > 0 ? ' ' : '') + words[i];
    yield { text, done: i === words.length - 1 };
    // No actual delay in tests
  }
}

/**
 * Creates a mock LLMService that returns predictable responses
 * based on the prompt content (detects which pipeline stage is calling).
 */
export function createMockLLMService() {
  return {
    name: 'mock',
    validate: vi.fn().mockResolvedValue({ valid: true }),
    listModels: vi.fn().mockResolvedValue(['mock-model-1', 'mock-model-2']),
    complete: vi.fn().mockImplementation(async (options: { messages: Array<{ content: string }> }) => {
      const lastMessage = options.messages[options.messages.length - 1]?.content || '';
      if (lastMessage.includes('TypeScript interfaces')) return MOCK_LLM_TYPE_GENERATION;
      if (lastMessage.includes('data processing')) return MOCK_LLM_DATA_MODULE;
      if (lastMessage.includes('React component')) return MOCK_LLM_COMPONENT;
      if (lastMessage.includes('root App.tsx')) return MOCK_LLM_APP_TSX;
      return 'Mock LLM response for: ' + lastMessage.substring(0, 50);
    }),
    stream: vi.fn().mockImplementation(async function* (options: { messages: Array<{ content: string }> }) {
      const response = 'Streaming mock response';
      yield* mockLLMStream(response);
    }),
  };
}

// ---------------------------------------------------------------------------
// 2. GITHUB API MOCKS
// ---------------------------------------------------------------------------

export function createMockGitHubService() {
  return {
    validateToken: vi.fn().mockResolvedValue({
      valid: true,
      username: 'test-user',
    }),
    listRepos: vi.fn().mockResolvedValue([
      { name: 'existing-repo', private: true, url: 'https://github.com/test-user/existing-repo' },
    ]),
    createRepo: vi.fn().mockResolvedValue({
      name: 'my-board',
      private: true,
      cloneUrl: 'https://github.com/test-user/my-board.git',
      htmlUrl: 'https://github.com/test-user/my-board',
    }),
    repoExists: vi.fn().mockResolvedValue(false),
    initAndPush: vi.fn().mockResolvedValue({
      success: true,
      commitSha: 'abc123def456',
    }),
    commitAndPush: vi.fn().mockResolvedValue({
      success: true,
      commitSha: 'def456abc789',
    }),
  };
}

// ---------------------------------------------------------------------------
// 3. VERCEL API MOCKS
// ---------------------------------------------------------------------------

export function createMockVercelService() {
  return {
    validateToken: vi.fn().mockResolvedValue({
      valid: true,
      user: { username: 'test-user', email: 'test@example.com' },
    }),
    createProject: vi.fn().mockResolvedValue({
      id: 'prj_test123',
      name: 'my-board',
      link: { type: 'github', repo: 'test-user/my-board' },
    }),
    getProject: vi.fn().mockResolvedValue({
      id: 'prj_test123',
      name: 'my-board',
    }),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
    triggerDeployment: vi.fn().mockResolvedValue({
      id: 'dpl_test456',
      readyState: 'QUEUED',
    }),
    getDeploymentStatus: vi.fn().mockResolvedValue({
      id: 'dpl_test456',
      readyState: 'READY',
      url: 'my-board-test.vercel.app',
    }),
    waitForDeployment: vi.fn().mockResolvedValue({
      success: true,
      url: 'https://my-board-test.vercel.app',
      duration: 45000,
    }),
  };
}

// ---------------------------------------------------------------------------
// 4. BUILD SERVICE MOCKS
// ---------------------------------------------------------------------------

export function createMockBuildService() {
  return {
    install: vi.fn().mockResolvedValue({ success: true, duration: 5000 }),
    build: vi.fn().mockResolvedValue({ success: true, duration: 3000 }),
    validate: vi.fn().mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
    }),
  };
}

/**
 * Mock build service that simulates a TypeScript compilation failure.
 * Used to test the LLM retry loop in code generation pipeline.
 */
export function createMockBuildServiceWithErrors() {
  let callCount = 0;
  return {
    install: vi.fn().mockResolvedValue({ success: true }),
    build: vi.fn().mockResolvedValue({ success: true }),
    validate: vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          valid: false,
          errors: [
            "src/components/Overview.tsx(15,5): error TS2304: Cannot find name 'ResponsiveContainer'.",
          ],
          warnings: [],
          stage: 'typescript',
        };
      }
      // Succeeds on 3rd attempt (simulates LLM fixing the error)
      return { valid: true, errors: [], warnings: [] };
    }),
  };
}

// ---------------------------------------------------------------------------
// 5. CONFIG SERVICE MOCKS
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory config store that behaves like ConfigService
 * but doesn't touch the filesystem.
 */
export function createMockConfigService() {
  const store: Record<string, unknown> = {};

  return {
    get: vi.fn().mockImplementation((key: string) => {
      const keys = key.split('.');
      let value: unknown = store;
      for (const k of keys) {
        value = (value as Record<string, unknown>)?.[k];
      }
      return value;
    }),
    set: vi.fn().mockImplementation((key: string, value: unknown) => {
      const keys = key.split('.');
      let target: Record<string, unknown> = store;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!(keys[i] in target)) target[keys[i]] = {};
        target = target[keys[i]] as Record<string, unknown>;
      }
      target[keys[keys.length - 1]] = value;
    }),
    has: vi.fn().mockImplementation((key: string) => {
      const keys = key.split('.');
      let value: unknown = store;
      for (const k of keys) {
        if (value == null || typeof value !== 'object') return false;
        value = (value as Record<string, unknown>)[k];
      }
      return value !== undefined;
    }),
    delete: vi.fn().mockImplementation((key: string) => {
      const keys = key.split('.');
      let target: Record<string, unknown> = store;
      for (let i = 0; i < keys.length - 1; i++) {
        target = target[keys[i]] as Record<string, unknown>;
        if (!target) return;
      }
      delete target[keys[keys.length - 1]];
    }),
    clear: vi.fn().mockImplementation(() => {
      for (const key of Object.keys(store)) delete store[key];
    }),
    getAll: vi.fn().mockImplementation(() => ({ ...store })),
    _store: store, // Exposed for test assertions
  };
}
