// Per-application profile switching (profiles phase 2).
//
// DeckBridge watches which monitored applications are *running* (via the app
// monitor's `ps` poll). It cannot see window focus — true focus detection is not
// available from Linux/WSL2 for Windows apps — so "per-app profile" here means
// "while this application is running", not "while it is focused". The decision of
// which profile should be active is kept as a pure function so it is unit-testable
// without a running daemon.

export interface AppProfileDecision {
  /** Profile to switch to, or null to stay on the current profile. */
  switchTo: string | null
  /** The application now driving the active profile, or null when back to manual. */
  activeApp: string | null
}

export interface AppProfileInput {
  /** Monitored applications currently running. */
  current: Set<string>
  /** Monitored applications running on the previous tick. */
  previous: Set<string>
  /** Map of application identifier → profile name to activate while it runs. */
  appToProfile: Map<string, string>
  /** Application that currently drives the auto-switched profile, or null. */
  activeApp: string | null
  /** Profile the user last chose manually — the fallback when no bound app runs. */
  manualProfile: string
}

/**
 * Decide which profile should be active given the set of running apps.
 *
 * - A bound app that just launched takes over (last launch in a tick wins).
 * - When the app driving the active profile exits, hand over to another running
 *   bound app, or fall back to the manual profile.
 * - Otherwise stay put.
 */
export function resolveAppProfileSwitch(input: AppProfileInput): AppProfileDecision {
  const { current, previous, appToProfile, activeApp, manualProfile } = input

  const boundRunning = [...current].filter((app) => appToProfile.has(app))

  // A bound app that appeared since the last tick takes priority.
  const launched = boundRunning.filter((app) => !previous.has(app))
  if (launched.length > 0) {
    const app = launched[launched.length - 1]
    return { switchTo: appToProfile.get(app)!, activeApp: app }
  }

  // The app driving the current auto-profile has gone away.
  if (activeApp !== null && !current.has(activeApp)) {
    if (boundRunning.length > 0) {
      const app = boundRunning[boundRunning.length - 1]
      return { switchTo: appToProfile.get(app)!, activeApp: app }
    }
    return { switchTo: manualProfile, activeApp: null }
  }

  return { switchTo: null, activeApp }
}

/** Build the application → profile lookup from a profile → application mapping. */
export function buildAppToProfile(profileApps: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>()
  for (const [profile, app] of Object.entries(profileApps)) {
    if (app) map.set(app, profile)
  }
  return map
}
