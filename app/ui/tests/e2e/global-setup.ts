import type { FullConfig } from '@playwright/test'
import { prepareCleanSlate } from './helpers/cleanup'

// Start every run from a clean slate, even if a prior run crashed before
// global-teardown. Runs once in the main process (never in workers). In the
// default (isolated) mode this wipes + recreates the ephemeral YACO_HOME; in
// E2E_REUSE mode it leaves the real registry untouched.
export default async function globalSetup(_config: FullConfig): Promise<void> {
  prepareCleanSlate()
}
