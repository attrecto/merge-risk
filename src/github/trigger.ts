// What started the run: an event that names its PR, or a relayed review that only names the
// commit. Review runs on fork PRs get a read-only token, so the review workflow does nothing and
// a `workflow_run` run, which gets the base repository's token, scores the PR in its place.
export type Trigger = { kind: 'pull-request'; number: number } | { kind: 'commit'; headSha: string }

export const SUPPORTED_EVENTS = [
  'pull_request',
  'pull_request_target',
  'pull_request_review',
  'workflow_run',
]

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined

const unsupported = (eventName: string): Error =>
  new Error(`merge-risk runs on ${SUPPORTED_EVENTS.join(', ')}; got ${eventName}`)

export const triggerFromEvent = (eventName: string, payload: unknown): Trigger => {
  if (!SUPPORTED_EVENTS.includes(eventName)) throw unsupported(eventName)
  if (eventName === 'workflow_run') {
    const headSha = field(field(payload, 'workflow_run'), 'head_sha')
    if (typeof headSha !== 'string') {
      throw new Error('merge-risk: the workflow_run event names no head commit')
    }
    return { kind: 'commit', headSha }
  }
  const number = field(field(payload, 'pull_request'), 'number')
  if (typeof number !== 'number') throw unsupported(eventName)
  return { kind: 'pull-request', number }
}

// A relayed review names only the commit: for a review on a fork PR, GitHub reports the base
// repository as the run's head repository, and the commit's PR lookup skips forks. If the head
// has since moved on, that push starts a run of its own, so only PRs still at the commit count.
export const pullRequestsAtCommit = (
  pulls: ReadonlyArray<{ number: number; head: { sha: string } }>,
  headSha: string,
): number[] => pulls.filter((pull) => pull.head.sha === headSha).map((pull) => pull.number)
