import { handleGitLabEvent, type WebhookConfig } from './webhook.ts'

import { afterEach, describe, expect, it, vi } from 'vitest'

const config = (): WebhookConfig => ({
  apiUrl: 'https://gl/api/v4',
  token: 'secret',
  selfUsername: 'merge-risk-bot',
  policyPath: '.merge-risk.yml',
  statusContext: 'merge-risk',
  warn: vi.fn(),
})

const mrEvent = (action: string | undefined, over: Record<string, unknown> = {}): unknown => ({
  object_kind: 'merge_request',
  project: { id: 42 },
  object_attributes: { iid: 7, action, ...over },
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('handleGitLabEvent — filtering', () => {
  it('ignores a non-merge-request event', async () => {
    const result = await handleGitLabEvent({ object_kind: 'push', project: { id: 42 } }, config())
    expect(result).toEqual({ status: 200, message: expect.stringContaining('not a merge request') })
  })

  it('ignores a push-carrying update (covered by the CI job)', async () => {
    const result = await handleGitLabEvent(mrEvent('update', { oldrev: 'abc123' }), config())
    expect(result.message).toContain('covered by the CI job')
  })

  it('ignores open/reopen (the CI job runs on those)', async () => {
    expect((await handleGitLabEvent(mrEvent('open'), config())).message).toContain(
      'covered by the CI job',
    )
  })

  it('rejects an unrecognised payload', async () => {
    expect((await handleGitLabEvent({ nope: true }, config())).status).toBe(400)
  })
})

const SAFE_POLICY = `
version: 1
default-tier: risky
tiers:
  safe: { approvals: 0 }
  risky: { approvals: 1 }
  very-risky: { approvals: 1 }
zones:
  - tier: safe
    paths: ['**/*.md']
`

const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers })

const mr = {
  author: { username: 'nikolett' },
  diff_refs: { base_sha: 'base', head_sha: 'head' },
  changes_count: '1',
  labels: [],
  reviewers: [],
}

describe('handleGitLabEvent — acting on an approval', () => {
  it('re-runs the gate and never creates the first report (update-only)', async () => {
    const posts: string[] = []
    const routes: Array<[(url: string) => boolean, () => Response]> = [
      [
        (url) => url.includes('/repository/files/'),
        () => new Response(SAFE_POLICY, { status: 200 }),
      ],
      [
        (url) => url.includes('/diffs') && url.includes('per_page=100'),
        () => json([{ old_path: 'docs/a.md', new_path: 'docs/a.md', diff: '@@ @@\n+line' }]),
      ],
      [(url) => url.includes('/diffs'), () => json([], { 'x-total': '1' })],
      [(url) => url.includes('/merge_requests/7/approvals'), () => json({ approved_by: [] })],
      [(url) => url.includes('/versions'), () => json([])],
      [(url) => url.includes('/notes'), () => json([])],
      [(url) => url.includes('/external_status_checks'), () => json([])],
    ]
    vi.stubGlobal('fetch', async (input: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') posts.push(input)
      return (routes.find(([matches]) => matches(input))?.[1] ?? (() => json(mr)))()
    })
    const result = await handleGitLabEvent(mrEvent('approved'), config())
    expect(result).toEqual({ status: 200, message: 'merge-risk: safe (success)' })
    expect(posts.some((url) => url.includes('/statuses/head'))).toBe(true)
    expect(posts.some((url) => url.includes('/notes'))).toBe(false)
  })
})
