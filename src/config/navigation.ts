/**
 * Where each screen goes when you back out of it.
 *
 * Back targets used to be a literal at every call site — `onNavigate('settings')`
 * repeated in an escape handler, a menu row and sometimes a third place in the
 * same file. Moving invoice fetching out of Settings meant finding all of them,
 * and missing one leaves a screen that escapes to where it used to live.
 *
 * As data, the hierarchy is stated once and can be asserted whole.
 */
import type { Screen } from '../App.js';

export const NAV_PARENT: Partial<Record<Screen, Screen>> = {
  setup: 'welcome',
  'create-board': 'welcome',
  'manage-boards': 'welcome',
  deploy: 'welcome',

  // Reading invoices out of a mailbox is a source of data, not a preference,
  // so Gmail hangs off Integrations rather than Settings.
  integrations: 'welcome',
  'integrations-gmail': 'integrations',
  'biller-studio': 'integrations-gmail',

  settings: 'welcome',
  'settings-mode': 'settings',
  'settings-vercel': 'settings',
  'settings-github': 'settings',
  'settings-llm': 'settings',
  'settings-dashboard-auth': 'settings',
};

/** The screen to return to, defaulting to the main menu. */
export function parentOf(screen: Screen): Screen {
  return NAV_PARENT[screen] ?? 'welcome';
}
