import { runGitLabGate } from '../gitlab/main.ts'
import { runWebhookServer } from '../gitlab/webhook-server.ts'
import { EVALUATE_USAGE, runEvaluate } from './evaluate-command.ts'

const USAGE = `Usage: merge-risk <command> [options]

Commands:
  evaluate         Score the current branch's committed changes locally (preview).
  gitlab-gate      Run the gate on a GitLab merge request from inside a CI job (reads CI_* env).
  gitlab-webhook   Start the webhook listener that re-runs the gate on approval events.

${EVALUATE_USAGE}`

const main = async (): Promise<void> => {
  const command = process.argv[2]
  if (command === 'gitlab-gate') {
    await runGitLabGate()
    return
  }
  if (command === 'gitlab-webhook') {
    await runWebhookServer()
    return
  }
  if (command === 'evaluate') {
    await runEvaluate(process.argv.slice(3))
    return
  }
  console.log(USAGE)
  process.exitCode = command === undefined || command === 'help' || command === '--help' ? 0 : 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
