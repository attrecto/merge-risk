import { createHandler, createSerialQueue } from './webhook-server.ts'
import type { WebhookConfig } from './webhook.ts'

import type { IncomingMessage, ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const config: WebhookConfig = {
  apiUrl: 'https://gl/api/v4',
  token: 'token',
  selfUsername: 'merge-risk-bot',
  policyPath: '.merge-risk.yml',
  statusContext: 'merge-risk-verdict',
  warn: vi.fn(),
}

// The injected gate run — a spy we can make hang, so a test can prove the 202 fires before it resolves.
const gate = vi.fn()

type FakeRes = ServerResponse & { statusCode: number; body: string }

const fakeReq = (body: string, token: string | undefined): IncomingMessage => {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers['x-gitlab-token'] = token
  return {
    method: 'POST',
    headers,
    setEncoding: () => undefined,
    async *[Symbol.asyncIterator]() {
      yield body
    },
  } as unknown as IncomingMessage
}

const fakeRes = (): FakeRes => {
  const res = {
    statusCode: 0,
    body: '',
    headersSent: false,
    writeHead(status: number) {
      res.statusCode = status
      res.headersSent = true
      return res
    },
    end(chunk?: string) {
      if (chunk !== undefined) res.body = chunk
    },
  }
  return res as unknown as FakeRes
}

const payload = (action: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: 42 },
    object_attributes: { iid: 7, action, ...over },
  })

describe('createHandler', () => {
  beforeEach(() => {
    gate.mockReset()
    gate.mockResolvedValue({ status: 200, message: 'ok' })
  })

  it('acks 202 before the gate runs, then runs it once with the parsed body', async () => {
    const res = fakeRes()
    let statusWhenGateStarted = -1
    gate.mockImplementation(async () => {
      statusWhenGateStarted = res.statusCode
      await sleep(20)
      return { status: 200, message: 'ok' }
    })

    const handler = createHandler(config, 'secret', gate)
    await handler(fakeReq(payload('approved'), 'secret'), res)

    // The reply is sent before the (slow) gate resolves — the whole point of the fix.
    expect(res.statusCode).toBe(202)
    expect(res.body).toContain('accepted')

    await sleep(40)
    expect(gate).toHaveBeenCalledTimes(1)
    expect(statusWhenGateStarted).toBe(202)
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({
        object_attributes: expect.objectContaining({ iid: 7, action: 'approved' }),
      }),
      config,
    )
  })

  it('replies 200 and skips the gate for a non-approval action', async () => {
    const res = fakeRes()
    const handler = createHandler(config, 'secret', gate)
    await handler(fakeReq(payload('update', { oldrev: 'abc123' }), 'secret'), res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('covered by the CI job')
    await sleep(0)
    expect(gate).not.toHaveBeenCalled()
  })

  it('rejects a bad token with 401 and never runs the gate', async () => {
    const res = fakeRes()
    const handler = createHandler(config, 'secret', gate)
    await handler(fakeReq(payload('approved'), 'wrong-token'), res)

    expect(res.statusCode).toBe(401)
    await sleep(0)
    expect(gate).not.toHaveBeenCalled()
  })
})

describe('createSerialQueue', () => {
  it('runs tasks for the same key one at a time, in enqueue order', async () => {
    const enqueue = createSerialQueue()
    const order: string[] = []

    // The first task is slow; the (instant) second must still land after it, proving serialisation.
    enqueue('mr-1', async () => {
      await sleep(30)
      order.push('first')
    })
    enqueue('mr-1', async () => {
      order.push('second')
    })

    await sleep(0)
    expect(order).toEqual([])
    await sleep(60)
    expect(order).toEqual(['first', 'second'])
  })

  it('runs different keys concurrently', async () => {
    const enqueue = createSerialQueue()
    const order: string[] = []

    // 'a' is slow, but 'b' has its own chain and finishes first.
    enqueue('a', async () => {
      await sleep(30)
      order.push('a')
    })
    enqueue('b', async () => {
      order.push('b')
    })

    await sleep(0)
    expect(order).toEqual(['b'])
    await sleep(60)
    expect(order).toEqual(['b', 'a'])
  })

  it('keeps running a key after an earlier task throws', async () => {
    const enqueue = createSerialQueue()
    const order: string[] = []

    enqueue('mr-1', async () => {
      throw new Error('boom')
    })
    enqueue('mr-1', async () => {
      order.push('after-error')
    })

    await sleep(0)
    expect(order).toEqual(['after-error'])
  })
})
