import { createFakeGitHub, type FakeGitHubState } from '../github/fake-github-port.ts'
import { changedFile } from '../test-support/fixtures.ts'
import { REPORT_MARKER } from './report.ts'
import { createGate } from './run-gate.ts'

import { describe, expect, it } from 'vitest'

const PR = { owner: 'attrecto', repo: 'monorepo', number: 7 }

const policyYaml = (riskyApprovals: number): string => `
version: 1
default-tier: risky
tiers:
  safe: { approvals: 0 }
  risky: { approvals: ${riskyApprovals} }
  very-risky: { approvals: 1 }
zones:
  - tier: safe
    paths: ['docs/**']
`

const setUp = (
  initial: Partial<FakeGitHubState> = {},
): ReturnType<typeof createFakeGitHub> & {
  run: () => ReturnType<ReturnType<typeof createGate>['run']>
} => {
  const fake = createFakeGitHub({
    contents: { 'base-sha': { '.merge-risk.yml': policyYaml(1) } },
    ...initial,
  })
  const gate = createGate({
    port: fake.port,
    policyPath: '.merge-risk.yml',
    workflowPath: '.github/workflows/merge-risk.yml',
    statusContext: 'merge-risk',
  })
  return { ...fake, run: async () => await gate.run(PR) }
}

describe('createGate', () => {
  it('reports a safe change as mergeable on the head commit', async () => {
    const { run, state } = setUp({ files: [changedFile('docs/a.md')] })
    await expect(run()).resolves.toMatchObject({
      tier: 'safe',
      decision: { state: 'success' },
      superseded: false,
    })
    expect(state.statuses).toEqual([
      {
        sha: 'head-sha',
        state: 'success',
        context: 'merge-risk',
        description: 'safe: No review required',
      },
    ])
  })

  it('holds a risky change until someone else approves the head commit', async () => {
    const { run, state } = setUp({ files: [changedFile('src/a.ts')] })
    await run()
    expect(state.statuses.at(-1)).toMatchObject({
      state: 'pending',
      description: 'risky: Needs 1 more approval',
    })
    state.reviews.push({
      reviewer: 'alice',
      isBot: false,
      hasWriteAccess: true,
      state: 'approved',
      commit: 'head-sha',
    })
    await run()
    expect(state.statuses.at(-1)).toMatchObject({ state: 'success' })
  })

  it("judges the PR by the base branch's policy, not the one the PR brings", async () => {
    const { run } = setUp({
      files: [changedFile('src/a.ts')],
      contents: {
        'base-sha': { '.merge-risk.yml': policyYaml(1) },
        'head-sha': { '.merge-risk.yml': policyYaml(0) },
      },
    })
    await expect(run()).resolves.toMatchObject({ decision: { state: 'pending' } })
  })

  it('treats a change to the policy or the gate workflow as very risky', async () => {
    const policyChange = setUp({ files: [changedFile('.merge-risk.yml')] })
    const workflowChange = setUp({ files: [changedFile('.github/workflows/merge-risk.yml')] })
    await expect(policyChange.run()).resolves.toMatchObject({ tier: 'very-risky' })
    await expect(workflowChange.run()).resolves.toMatchObject({ tier: 'very-risky' })
  })

  it('swaps a stale tier label for the current one and keeps other labels', async () => {
    const { run, state } = setUp({
      files: [changedFile('src/a.ts')],
      labels: ['merge-risk:safe', 'frontend'],
    })
    await run()
    expect(state.labels).toEqual(['frontend', 'merge-risk:risky'])
  })

  it('updates its own report in place and leaves a human comment quoting the marker alone', async () => {
    const human = { id: 1, body: `quoting ${REPORT_MARKER}`, isBot: false }
    const { run, state } = setUp({ files: [changedFile('docs/a.md')], comments: [human] })
    await run()
    state.files = [changedFile('src/a.ts')]
    await run()
    expect(state.comments).toHaveLength(2)
    expect(state.comments[0]).toEqual(human)
    expect(state.comments[1]?.body).toContain('## Merge risk: `risky`')
  })

  it('posts nothing when a push lands while the PR is being scored', async () => {
    const { run, state } = setUp({ files: [changedFile('docs/a.md')] })
    state.duringListFiles = () => {
      state.pull = { ...state.pull, headSha: 'newer-sha' }
    }
    await expect(run()).resolves.toMatchObject({ superseded: true })
    expect(state.statuses).toEqual([])
    expect(state.labels).toEqual([])
    expect(state.comments).toEqual([])
  })

  it('still reports when only the base branch moved on during the run', async () => {
    const { run, state } = setUp({ files: [changedFile('docs/a.md')] })
    state.duringListFiles = () => {
      state.pull = { ...state.pull, baseSha: 'newer-base-sha' }
    }
    await expect(run()).resolves.toMatchObject({ superseded: false })
    expect(state.statuses).toEqual([expect.objectContaining({ sha: 'head-sha', state: 'success' })])
  })

  it('keeps the original error when the error status cannot be posted either', async () => {
    const { run, state } = setUp({ contents: {}, statusError: new Error('403 read-only token') })
    await expect(run()).rejects.toThrow('No .merge-risk.yml on the base branch')
    expect(state.statuses).toEqual([])
  })

  it('reports an error status and rethrows when the base branch has no policy', async () => {
    const { run, state } = setUp({ contents: {} })
    await expect(run()).rejects.toThrow('No .merge-risk.yml on the base branch')
    expect(state.statuses).toEqual([
      expect.objectContaining({
        state: 'error',
        description: expect.stringContaining('Could not evaluate'),
      }),
    ])
  })

  it('in update-only mode refreshes an existing report but never creates the first one', async () => {
    const fake = createFakeGitHub({
      contents: { 'base-sha': { '.merge-risk.yml': policyYaml(1) } },
      files: [changedFile('src/a.ts')],
    })
    const base = {
      port: fake.port,
      policyPath: '.merge-risk.yml',
      workflowPath: '.github/workflows/merge-risk.yml',
      statusContext: 'merge-risk',
    }
    const updateOnly = createGate({ ...base, reportMode: 'update-only' })
    await updateOnly.run(PR)
    expect(fake.state.comments).toEqual([])

    // A normal (create-or-update) run seeds the report; a later update-only run edits it in place.
    await createGate(base).run(PR)
    expect(fake.state.comments).toHaveLength(1)
    fake.state.files = [changedFile('docs/a.md')]
    await updateOnly.run(PR)
    expect(fake.state.comments).toHaveLength(1)
    expect(fake.state.comments[0]?.body).toContain('## Merge risk: `safe`')
  })
})
