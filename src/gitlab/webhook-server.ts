import { DEFAULT_POLICY_PATH, DEFAULT_STATUS_CONTEXT, envOr, required } from './env.ts'
import {
  classifyGitLabEvent,
  handleGitLabEvent,
  type WebhookConfig,
  type WebhookResult,
} from './webhook.ts'

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'

const userSchema = z.object({ username: z.string() })

// GitLab MR webhook payloads are small (a few KB); cap well above that and reject the rest.
const MAX_BODY_BYTES = 1_000_000

// Constant-time secret check so a wrong token can't be recovered by timing the response (CWE-208).
const tokenMatches = (header: string | string[] | undefined, secret: string): boolean => {
  if (typeof header !== 'string') return false
  const given = Buffer.from(header)
  const want = Buffer.from(secret)
  return given.length === want.length && timingSafeEqual(given, want)
}

class PayloadTooLargeError extends Error {}

const logError = (error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error))
}

const readSelfUsername = async (apiUrl: string, token: string): Promise<string> => {
  const res = await fetch(`${apiUrl}/user`, { headers: { 'PRIVATE-TOKEN': token } })
  if (!res.ok) throw new Error(`merge-risk: could not read the token user (GitLab ${res.status})`)
  const body: unknown = await res.json()
  return userSchema.parse(body).username
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  // setEncoding runs a StringDecoder, which reassembles a multibyte UTF-8 character split across TCP
  // chunks (e.g. accented text in a Hungarian MR title) — decoding each Buffer chunk alone corrupts it.
  req.setEncoding('utf8')
  let body = ''
  for await (const chunk of req) {
    body += String(chunk)
    if (body.length > MAX_BODY_BYTES) throw new PayloadTooLargeError()
  }
  return body
}

const respond = (res: ServerResponse, status: number, message: string): void => {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(message)
}

// Run tasks for the same key strictly one after another, across the whole server's lifetime. GitLab
// re-delivers on timeout and fires approval/unapproval in quick succession, so two deliveries for one
// MR can arrive overlapping; serialising per MR makes the latest event's result always land last
// instead of racing. Keys drop out of the map once their chain drains, so it can't grow unbounded.
export const createSerialQueue = (): ((key: string, task: () => Promise<void>) => void) => {
  const chains = new Map<string, Promise<void>>()
  return (key, task) => {
    const prev = chains.get(key) ?? Promise.resolve()
    const next = prev
      .then(task)
      .catch(logError)
      .finally(() => {
        if (chains.get(key) === next) chains.delete(key)
      })
    chains.set(key, next)
  }
}

export const createHandler = (
  config: WebhookConfig,
  secret: string,
  // Injectable so a test can drive the ack-before-gate wiring without a live GitLab; defaults to the
  // real gate run, which is what the server uses.
  runEvent: (body: unknown, config: WebhookConfig) => Promise<WebhookResult> = handleGitLabEvent,
): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
  const enqueue = createSerialQueue()
  return async (req, res) => {
    if (req.method !== 'POST') {
      respond(res, 405, 'merge-risk: POST only')
      return
    }
    // Access control: only GitLab, which knows the shared secret, may trigger a re-evaluation.
    if (!tokenMatches(req.headers['x-gitlab-token'], secret)) {
      respond(res, 401, 'merge-risk: invalid token')
      return
    }
    let raw: string
    try {
      raw = await readBody(req)
    } catch (error) {
      // Only an over-cap body is 413; a stream/socket error (reset, abort) is a client error, not that.
      if (error instanceof PayloadTooLargeError) respond(res, 413, 'merge-risk: payload too large')
      else respond(res, 400, 'merge-risk: could not read request body')
      return
    }
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(raw)
    } catch {
      respond(res, 400, 'merge-risk: invalid JSON')
      return
    }
    const classified = classifyGitLabEvent(parsedBody)
    // Ignored events (non-approval, non-MR, bad payload) need no gate run — reply with the reason now.
    if (classified.kind === 'ignore') {
      respond(res, classified.result.status, classified.result.message)
      return
    }
    // The gate makes several sequential GitLab calls, which on a large MR can exceed GitLab's ~10s
    // webhook timeout. A timed-out delivery is marked failed, re-delivered (overlapping runs), and
    // counts toward auto-disabling the hook. So ACK immediately and run the gate in the background,
    // serialised per MR so a later event's result always lands last. The run is idempotent (status
    // keyed by head SHA, report update-only), so a re-delivery that still slips through re-converges.
    respond(res, 202, `merge-risk: accepted, re-evaluating !${classified.iid}`)
    enqueue(classified.key, async () => {
      await runEvent(parsedBody, config)
    })
  }
}

// The PR-figyelő service: a tiny listener that re-runs the gate when an approval lands (which never
// starts a pipeline), so the required check turns green without anyone re-running the CI job.
export const runWebhookServer = async (): Promise<void> => {
  // Boot fail-fast: a missing secret/token must stop the process, not leave a silently useless server.
  const apiUrl = required('MERGE_RISK_API_URL', process.env['MERGE_RISK_API_URL'])
  const token = required('MERGE_RISK_TOKEN', process.env['MERGE_RISK_TOKEN'])
  const secret = required('MERGE_RISK_WEBHOOK_SECRET', process.env['MERGE_RISK_WEBHOOK_SECRET'])
  const policyPath = envOr('MERGE_RISK_POLICY', DEFAULT_POLICY_PATH)
  const statusContext = envOr('MERGE_RISK_STATUS_CONTEXT', DEFAULT_STATUS_CONTEXT)
  // envOr (not `??`) so an empty PORT falls back to 3000 instead of Number('') === 0 → a random,
  // silently unreachable port. Require a real listen port (1..65535), rejecting a 0 or typo'd value.
  const listenPort = Number(envOr('PORT', '3000'))
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error(
      `merge-risk: PORT must be a valid port number, got "${process.env['PORT'] ?? ''}"`,
    )
  }

  const selfUsername = await readSelfUsername(apiUrl, token)
  const config: WebhookConfig = {
    apiUrl,
    token,
    selfUsername,
    policyPath,
    statusContext,
    warn: (message) => {
      console.warn(message)
    },
  }
  const listener = createHandler(config, secret)
  const server = createServer((req, res) => {
    void listener(req, res).catch((error: unknown) => {
      logError(error)
      if (!res.headersSent) respond(res, 500, 'merge-risk: webhook error')
    })
  })
  server.listen(listenPort, () => {
    console.log(`merge-risk: webhook listening on :${listenPort}`)
  })
  const shutdown = (): void => {
    server.close(() => {
      process.exitCode = 0
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
