import { parsePolicy, PolicyError } from '../policy/parse-policy.ts'
import { assessRisk } from './assess.ts'
import { decideGate, type GateDecision } from './gate.ts'
import { renderReport, REPORT_MARKER } from './report.ts'
import type { ChangeRef, PullRequest, ReviewPort } from './review-port.ts'
import type { Tier } from './tier.ts'
import type { Policy } from './types.ts'

export const LABEL_PREFIX = 'merge-risk:'

const MAX_STATUS_DESCRIPTION = 140

// 'update-only' edits an existing report but never creates the first one — for a re-run (e.g. a webhook
// reacting to an approval) that could otherwise race the initial run and post a duplicate report.
export type ReportMode = 'create-or-update' | 'update-only'

export type GateConfig = {
  port: ReviewPort
  policyPath: string
  // The workflow file running the gate; editing it is as sensitive as editing the policy.
  workflowPath: string | undefined
  statusContext: string
  reportMode?: ReportMode
}

export type GateRun = {
  tier: Tier
  decision: GateDecision
  // A push landed while the PR was scored; the run its `synchronize` event starts reports instead.
  superseded: boolean
}

export type Gate = {
  run: (pr: ChangeRef) => Promise<GateRun>
}

const truncate = (text: string): string =>
  text.length > MAX_STATUS_DESCRIPTION ? `${text.slice(0, MAX_STATUS_DESCRIPTION - 1)}…` : text

export const createGate = ({
  port,
  policyPath,
  workflowPath,
  statusContext,
  reportMode = 'create-or-update',
}: GateConfig): Gate => {
  const protectedPaths = workflowPath === undefined ? [policyPath] : [policyPath, workflowPath]

  // Read from the base commit, never the head, so a PR can't loosen the policy that judges it.
  const loadPolicy = async (pr: ChangeRef, pull: PullRequest): Promise<Policy> => {
    const text = await port.readFile(pr, policyPath, pull.baseSha)
    if (text === undefined) {
      throw new PolicyError(`No ${policyPath} on the base branch (${pull.baseSha})`)
    }
    return parsePolicy(text)
  }

  const syncLabel = async (pr: ChangeRef, tier: Tier): Promise<void> => {
    const wanted = `${LABEL_PREFIX}${tier}`
    const labels = await port.listLabels(pr)
    const stale = labels.filter((label) => label.startsWith(LABEL_PREFIX) && label !== wanted)
    await Promise.all(
      stale.map(async (label) => {
        await port.removeLabel(pr, label)
      }),
    )
    if (!labels.includes(wanted)) await port.addLabel(pr, wanted)
  }

  const upsertReport = async (pr: ChangeRef, body: string): Promise<void> => {
    const comments = await port.listComments(pr)
    // Only a bot's comment counts, so a person quoting the marker can't take over the report.
    // That's also why the action supports GITHUB_TOKEN and app tokens but not personal tokens.
    const existing = comments.find(
      (comment) => comment.isBot && comment.body.includes(REPORT_MARKER),
    )
    if (existing === undefined) {
      if (reportMode === 'update-only') return
      await port.createComment(pr, body)
    } else if (existing.body !== body) await port.updateComment(pr, existing.id, body)
  }

  const evaluate = async (pr: ChangeRef, pull: PullRequest): Promise<GateRun> => {
    const [policy, files, reviews] = await Promise.all([
      loadPolicy(pr, pull),
      port.listFiles(pr),
      port.listReviews(pr),
    ])
    const assessment = assessRisk({ policy, files, protectedPaths, totalFiles: pull.changedFiles })
    const decision = decideGate({
      policy,
      tier: assessment.tier,
      author: pull.author,
      headCommit: pull.headSha,
      reviews,
    })
    // The file listing follows the live head, not `pull.headSha`. A push during the run would
    // otherwise post a verdict on a commit it wasn't computed for.
    const current = await port.getPullRequest(pr)
    // Only the head counts: no event follows the base branch moving on, and the policy read at the
    // starting base was the real base when the run began.
    if (current.headSha !== pull.headSha) {
      return { tier: assessment.tier, decision, superseded: true }
    }
    await syncLabel(pr, assessment.tier)
    await upsertReport(pr, renderReport({ policy, assessment, decision }))
    await port.setStatus(pr, {
      sha: pull.headSha,
      state: decision.state,
      context: statusContext,
      description: truncate(`${assessment.tier}: ${decision.summary}`),
    })
    return { tier: assessment.tier, decision, superseded: false }
  }

  return {
    run: async (pr) => {
      const pull = await port.getPullRequest(pr)
      try {
        return await evaluate(pr, pull)
      } catch (error) {
        // Without a status the required check would sit unreported, which reads like a hung run.
        const description = truncate(
          `Could not evaluate: ${error instanceof Error ? error.message : String(error)}`,
        )
        // A failure here (e.g. a read-only token) must not mask the error that got us here.
        await port
          .setStatus(pr, { sha: pull.headSha, state: 'error', context: statusContext, description })
          .catch(() => undefined)
        throw error
      }
    },
  }
}
