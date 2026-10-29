import { pullRequestsAtCommit, triggerFromEvent } from './trigger.ts'

import { describe, expect, it } from 'vitest'

describe('triggerFromEvent', () => {
  it('takes the PR number from pull request and review events', () => {
    for (const eventName of ['pull_request', 'pull_request_target', 'pull_request_review']) {
      expect(triggerFromEvent(eventName, { pull_request: { number: 7 } })).toEqual({
        kind: 'pull-request',
        number: 7,
      })
    }
  })

  it('takes the head commit from a workflow_run event', () => {
    // A review on a fork PR reports the base repository as the head repository.
    const payload = {
      workflow_run: {
        head_repository: { owner: { login: 'attrecto' } },
        head_branch: 'fix/typo',
        head_sha: 'abc123',
      },
    }
    expect(triggerFromEvent('workflow_run', payload)).toEqual({ kind: 'commit', headSha: 'abc123' })
  })

  it('rejects a workflow_run without a head commit', () => {
    expect(() => triggerFromEvent('workflow_run', { workflow_run: {} })).toThrow(/head commit/)
  })

  it('rejects other events and events without a PR', () => {
    expect(() => triggerFromEvent('push', {})).toThrow(/got push/)
    expect(() => triggerFromEvent('pull_request', {})).toThrow(/got pull_request/)
  })
})

describe('pullRequestsAtCommit', () => {
  it('keeps only the PRs whose head is still the reviewed commit', () => {
    const pulls = [
      { number: 1, head: { sha: 'abc123' } },
      { number: 2, head: { sha: 'def456' } },
      { number: 3, head: { sha: 'abc123' } },
    ]
    expect(pullRequestsAtCommit(pulls, 'abc123')).toEqual([1, 3])
  })
})
