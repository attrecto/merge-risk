import { createGitHubPort } from './github-port.ts'
import { createGitHubGate } from './run-gate.ts'
import { pullRequestsAtCommit, type Trigger, triggerFromEvent } from './trigger.ts'
import { workflowPathFromRef } from './workflow-path.ts'

import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'

type Octokit = ReturnType<typeof getOctokit>

// A fork's PRs are absent from the workflow_run payload, so they are looked up by head branch.
const pullRequestNumbers = async (octokit: Octokit, trigger: Trigger): Promise<number[]> => {
  if (trigger.kind === 'pull-request') return [trigger.number]
  const pulls = await octokit.paginate(octokit.rest.pulls.list, {
    ...context.repo,
    state: 'open',
    head: `${trigger.headOwner}:${trigger.headBranch}`,
    per_page: 100,
  })
  return pullRequestsAtCommit(pulls, trigger.headSha)
}

const main = async (): Promise<void> => {
  const trigger = triggerFromEvent(context.eventName, context.payload)
  const octokit = getOctokit(core.getInput('github-token', { required: true }))
  const gate = createGitHubGate({
    port: createGitHubPort(octokit),
    policyPath: core.getInput('policy-path', { required: true }),
    workflowPath: workflowPathFromRef(process.env['GITHUB_WORKFLOW_REF']),
    statusContext: core.getInput('status-context', { required: true }),
  })
  const numbers = await pullRequestNumbers(octokit, trigger)
  if (numbers.length === 0) {
    core.info('merge-risk: no open PR is at the reviewed commit; nothing to score.')
    return
  }
  const runs = await Promise.all(
    numbers.map(async (number) => ({
      number,
      ...(await gate.run({ ...context.repo, number })),
    })),
  )
  for (const { number, tier, decision, superseded } of runs) {
    if (superseded) {
      core.info(
        `merge-risk: #${number} changed during the run; the run for the new commit reports.`,
      )
      continue
    }
    core.setOutput('tier', tier)
    core.setOutput('state', decision.state)
    core.info(`merge-risk: #${number} ${tier} (${decision.state}): ${decision.summary}`)
  }
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error))
})
