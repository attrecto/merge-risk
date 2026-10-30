export const DEFAULT_POLICY_PATH = '.merge-risk.yml'

// The status name must NOT collide with the job name: GitLab already posts a commit status named after
// the job, so a second status of the same name 400s "name has already been taken" and never appears.
// Shared so the CI gate (main.ts) and the webhook (webhook-server.ts) can't drift to different defaults.
export const DEFAULT_STATUS_CONTEXT = 'merge-risk-verdict'

export const required = (name: string, value: string | undefined): string => {
  if (value === undefined || value === '') throw new Error(`merge-risk: ${name} is required`)
  return value
}

// A defined-but-empty CI variable falls back to the default (an empty env var is "unset" to us).
export const envOr = (name: string, fallback: string): string => {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}
