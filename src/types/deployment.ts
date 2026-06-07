/**
 * Deployment type definitions for OpenBoard.
 * Covers GitHub repository creation and Vercel deployment.
 */

export type DeploymentProvider = 'vercel';
export type DeploymentStatus = 'pending' | 'creating-repo' | 'pushing' | 'deploying' | 'ready' | 'error';

export interface GitHubRepoOptions {
  name: string;
  description?: string;
  private?: boolean;
  autoInit?: boolean;
}

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  private: boolean;
  createdAt: string;
}

export interface VercelDeploymentOptions {
  projectName: string;
  repoUrl?: string;
  framework?: string;
  envVars?: Record<string, string>;
  teamId?: string;
}

export interface VercelDeployment {
  id: string;
  url: string;
  state: 'BUILDING' | 'ERROR' | 'INITIALIZING' | 'QUEUED' | 'READY' | 'CANCELED';
  createdAt: number;
  buildingAt?: number;
  readyAt?: number;
  errorMessage?: string;
}

export interface VercelProject {
  id: string;
  name: string;
  accountId: string;
  framework?: string;
  latestDeployments?: VercelDeployment[];
}

export interface EnvironmentVariables {
  DASHBOARD_USERNAME: string;
  DASHBOARD_PASSWORD_HASH: string;
  JWT_SECRET: string;
  [key: string]: string;
}

export interface DeploymentResult {
  success: boolean;
  provider: DeploymentProvider;
  deployedUrl?: string;
  repoUrl?: string;
  errorMessage?: string;
  steps: DeploymentStep[];
}

export interface DeploymentStep {
  name: string;
  status: 'pending' | 'running' | 'done' | 'error';
  message?: string;
  startedAt?: number;
  completedAt?: number;
}
