// Stand-in for the dsh launcher at the process boundary. It records its
// argv, environment, and working directory into the workspace, copies the
// pre-built session logs named by FAKE_DSH_SESSIONS into $DSH_HOME/sessions,
// and then acts on the prompt (the last argument):
//   write:<file>:<text>  write <text> to <file> in the workspace, exit 0
//   hang                 never exit (exercises the run timeout)
//   persist-hang         persist the sessions, then never exit
//   nosession            exit 1 without persisting a session
// It also prints the model key it received, so redaction can be checked,
// writes its pid to FAKE_DSH_PID when set, and, when FAKE_DSH_INACTIVE names
// a package, prints dsh's "did not activate" warning for a row of it.
import { cpSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const prompt = process.argv.at(-1)
if (process.env.DEEPSEEK_API_KEY !== undefined) process.stderr.write(`using key ${process.env.DEEPSEEK_API_KEY}\n`)
if (process.env.FAKE_DSH_PID !== undefined) writeFileSync(process.env.FAKE_DSH_PID, String(process.pid))
if (process.env.FAKE_DSH_INACTIVE !== undefined) {
  process.stderr.write(`dsh: warning: 1 entries did not activate\nrow (${process.env.FAKE_DSH_INACTIVE}): pending (waiting for service: browser)\n`)
}
writeFileSync(join(process.cwd(), 'launch.json'), JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  home: process.env.DSH_HOME,
  extra: process.env.FAKE_EXTRA,
  credentials: existsSync(join(process.env.DSH_HOME, 'credentials.yaml')),
}))
if (prompt === 'hang') setInterval(() => {}, 1000)
else if (prompt === 'persist-hang') {
  cpSync(process.env.FAKE_DSH_SESSIONS, join(process.env.DSH_HOME, 'sessions'), { recursive: true })
  setInterval(() => {}, 1000)
}
else if (prompt === 'nosession') process.exit(1)
else {
  cpSync(process.env.FAKE_DSH_SESSIONS, join(process.env.DSH_HOME, 'sessions'), { recursive: true })
  const [, file, text] = prompt.split(':')
  writeFileSync(join(process.cwd(), file), text)
  process.stdout.write('done\n')
}
