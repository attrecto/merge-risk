import { createGate } from '../core/run-gate.ts'
import { createGitLabPort } from './gitlab-port.ts'

import { z } from 'zod'

const webhookSchema = z.object({
  object_kind: z.string(),
  project: z.object({ id: z.number() }),
  object_attributes: z.object({ iid: z.number(), action: z.string().optional() }).optional(),
})

export type WebhookConfig = {
  apiUrl: string
  token: string
  selfUsername: string
  policyPath: string
  statusContext: string
  warn: (message: string) => void
}

export type WebhookResult = { status: number; message: string }

// Approval/review-state changes are the gap: they don't start a pipeline, so the CI job never re-runs
// on them. A plain MR `update` carries `oldrev` (a push) and is already covered by the CI job, so only
// these approval-class actions are worth re-evaluating here.
const APPROVAL_ACTIONS: ReadonlySet<string> = new Set([
  'approved',
  'unapproved',
  'approval',
  'unapproval',
])

// Re-run the gate for a single merge request in reaction to a GitLab webhook event. Reuses the exact
// same gate the CI job runs; only re-reports (never creates the first report) so it can't race the job.
export const handleGitLabEvent = async (
  body: unknown,
  config: WebhookConfig,
): Promise<WebhookResult> => {
  const parsed = webhookSchema.safeParse(body)
  if (!parsed.success) return { status: 400, message: 'merge-risk: unrecognised webhook payload' }
  const event = parsed.data
  if (event.object_kind !== 'merge_request' || event.object_attributes === undefined) {
    return { status: 200, message: 'merge-risk: ignored (not a merge request event)' }
  }
  const action = event.object_attributes.action
  if (action === undefined || !APPROVAL_ACTIONS.has(action)) {
    return {
      status: 200,
      message: `merge-risk: ignored (action "${action ?? 'none'}" is covered by the CI job)`,
    }
  }
  const port = createGitLabPort({
    apiUrl: config.apiUrl,
    projectId: String(event.project.id),
    token: config.token,
    selfUsername: config.selfUsername,
    warn: config.warn,
  })
  const gate = createGate({
    port,
    policyPath: config.policyPath,
    workflowPath: '.gitlab-ci.yml',
    statusContext: config.statusContext,
    reportMode: 'update-only',
  })
  const run = await gate.run({ owner: '', repo: '', number: event.object_attributes.iid })
  return { status: 200, message: `merge-risk: ${run.tier} (${run.decision.state})` }
}
