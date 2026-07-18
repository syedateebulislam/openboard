import { modeAllowsDeploy, type AppMode } from '../config/appModes.js';

export type WizardStep = 'mode' | 'llm' | 'github' | 'vercel' | 'credentials';

export interface SetupWizardNavigationState {
  step: WizardStep;
  mode: AppMode;
}

export type SetupWizardNavigationAction =
  | { type: 'select_mode'; mode: AppMode }
  | { type: 'llm_complete' }
  | { type: 'github_complete' }
  | { type: 'vercel_complete' }
  | { type: 'go'; step: WizardStep };

export function visibleWizardSteps(mode: AppMode): WizardStep[] {
  return modeAllowsDeploy(mode)
    ? ['mode', 'llm', 'github', 'vercel', 'credentials']
    : ['mode', 'llm', 'credentials'];
}

/** Pure setup navigation state machine; validation side effects stay in handlers. */
export function setupWizardNavigationReducer(
  state: SetupWizardNavigationState,
  action: SetupWizardNavigationAction,
): SetupWizardNavigationState {
  switch (action.type) {
    case 'select_mode': return { mode: action.mode, step: 'llm' };
    case 'llm_complete': return { ...state, step: modeAllowsDeploy(state.mode) ? 'github' : 'credentials' };
    case 'github_complete': return { ...state, step: 'vercel' };
    case 'vercel_complete': return { ...state, step: 'credentials' };
    case 'go': return { ...state, step: action.step };
  }
}

