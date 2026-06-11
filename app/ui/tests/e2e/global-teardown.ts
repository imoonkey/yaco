import type { FullConfig } from '@playwright/test'
import { removeE2eArtifacts } from './helpers/cleanup'

// Remove the ephemeral YACO_HOME + any leaked $HOME browse fixtures so e2e never
// accumulates state in /tmp or ~. Runs once in the main process after all tests.
export default async function globalTeardown(_config: FullConfig): Promise<void> {
  removeE2eArtifacts()
}
