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

// An approval event needs a gate re-run; anything else is ignored (with the reason as the reply).
export type EventClassification =
  | { kind: 'ignore'; result: WebhookResult }
  | { kind: 'run'; projectId: string; iid: number; key: string }

// Approval/review-state changes are the gap: they don't start a pipeline, so the CI job never re-runs
// on them. A plain MR `update` carries `oldrev` (a push) and is already covered by the CI job, so only
// these approval-class actions are worth re-evaluating here.
const APPROVAL_ACTIONS: ReadonlySet<string> = new Set([
  'approved',
  'unapproved',
  'approval',
  'unapproval',
])

// Validate the payload and decide whether it needs a gate re-run — no network, so the server can ACK
// (and queue the slow gate run) before any GitLab API call. `key` serialises overlapping deliveries of
// the same MR. Returns the ignore reason as a ready-to-send reply for events that need no work.
export const classifyGitLabEvent = (body: unknown): EventClassification => {
  const parsed = webhookSchema.safeParse(body)
  if (!parsed.success) {
    return {
      kind: 'ignore',
      result: { status: 400, message: 'merge-risk: unrecognised webhook payload' },
    }
  }
  const event = parsed.data
  if (event.object_kind !== 'merge_request' || event.object_attributes === undefined) {
    return {
      kind: 'ignore',
      result: { status: 200, message: 'merge-risk: ignored (not a merge request event)' },
    }
  }
  const action = event.object_attributes.action
  if (action === undefined || !APPROVAL_ACTIONS.has(action)) {
    return {
      kind: 'ignore',
      result: {
        status: 200,
        message: `merge-risk: ignored (action "${action ?? 'none'}" is covered by the CI job)`,
      },
    }
  }
  const projectId = String(event.project.id)
  const iid = event.object_attributes.iid
  return { kind: 'run', projectId, iid, key: `${projectId}:${iid}` }
}

// Re-run the gate for a single merge request in reaction to a GitLab webhook event. Reuses the exact
// same gate the CI job runs; only re-reports (never creates the first report) so it can't race the job.
export const handleGitLabEvent = async (
  body: unknown,
  config: WebhookConfig,
): Promise<WebhookResult> => {
  const classified = classifyGitLabEvent(body)
  if (classified.kind === 'ignore') return classified.result
  const port = createGitLabPort({
    apiUrl: config.apiUrl,
    projectId: classified.projectId,
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
  const run = await gate.run({ owner: '', repo: '', number: classified.iid })
  return { status: 200, message: `merge-risk: ${run.tier} (${run.decision.state})` }
}
