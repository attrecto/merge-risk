import { handleGitLabEvent, type WebhookConfig } from './webhook.ts'

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'

const userSchema = z.object({ username: z.string() })

const required = (name: string, value: string | undefined): string => {
  if (value === undefined || value === '') throw new Error(`merge-risk: ${name} is required`)
  return value
}

const readSelfUsername = async (apiUrl: string, token: string): Promise<string> => {
  const res = await fetch(`${apiUrl}/user`, { headers: { 'PRIVATE-TOKEN': token } })
  if (!res.ok) throw new Error(`merge-risk: could not read the token user (GitLab ${res.status})`)
  const body: unknown = await res.json()
  return userSchema.parse(body).username
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  return body
}

const respond = (res: ServerResponse, status: number, message: string): void => {
  res.writeHead(status, { 'content-type': 'text/plain' })
  res.end(message)
}

const createHandler =
  (config: WebhookConfig, secret: string) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      respond(res, 405, 'merge-risk: POST only')
      return
    }
    // Access control: only GitLab, which knows the shared secret, may trigger a re-evaluation.
    if (req.headers['x-gitlab-token'] !== secret) {
      respond(res, 401, 'merge-risk: invalid token')
      return
    }
    try {
      const parsedBody: unknown = JSON.parse(await readBody(req))
      const result = await handleGitLabEvent(parsedBody, config)
      respond(res, result.status, result.message)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      respond(res, 500, 'merge-risk: webhook error')
    }
  }

// The PR-figyelő service: a tiny listener that re-runs the gate when an approval lands (which never
// starts a pipeline), so the required check turns green without anyone re-running the CI job.
export const runWebhookServer = async (): Promise<void> => {
  // Boot fail-fast: a missing secret/token must stop the process, not leave a silently useless server.
  const apiUrl = required('MERGE_RISK_API_URL', process.env['MERGE_RISK_API_URL'])
  const token = required('MERGE_RISK_TOKEN', process.env['MERGE_RISK_TOKEN'])
  const secret = required('MERGE_RISK_WEBHOOK_SECRET', process.env['MERGE_RISK_WEBHOOK_SECRET'])
  const policyPath = process.env['MERGE_RISK_POLICY'] ?? '.merge-risk.yml'
  const statusContext = process.env['MERGE_RISK_STATUS_CONTEXT'] ?? 'merge-risk'
  const listenPort = Number(process.env['PORT'] ?? '3000')

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
    void listener(req, res)
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
