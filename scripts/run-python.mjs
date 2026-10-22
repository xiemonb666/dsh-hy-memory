import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function interpreterIn(environmentDirectory) {
  return join(environmentDirectory, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
}

export function resolvePythonExecutable({
  root = repoRoot,
  environment = process.env,
  exists = existsSync,
  spawn = spawnSync,
} = {}) {
  const explicitInterpreter = environment.HYMEM_PYTHON?.trim()
  if (explicitInterpreter) return explicitInterpreter

  const explicitEnvironment = environment.UV_PROJECT_ENVIRONMENT?.trim()
  if (explicitEnvironment) {
    const environmentDirectory = isAbsolute(explicitEnvironment)
      ? resolve(explicitEnvironment)
      : resolve(root, explicitEnvironment)
    const interpreter = interpreterIn(environmentDirectory)
    if (!exists(interpreter)) {
      throw new Error(`UV_PROJECT_ENVIRONMENT has no Python interpreter at ${interpreter}`)
    }
    return interpreter
  }

  const localInterpreter = interpreterIn(join(root, '.venv'))
  if (exists(localInterpreter)) return localInterpreter

  const commands = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']
  for (const command of commands) {
    const result = spawn(command, ['--version'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    })
    if (!result.error && result.status === 0) return command
  }
  throw new Error(`No Python interpreter was found. Set HYMEM_PYTHON or create ${join(root, '.venv')}.`)
}

export function runPython(args = process.argv.slice(2), options = {}) {
  const root = options.root ?? repoRoot
  const environment = options.environment ?? process.env
  let executable
  try {
    executable = resolvePythonExecutable({ ...options, root, environment })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const result = (options.spawn ?? spawnSync)(executable, args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) {
    process.stderr.write(`Could not start Python (${executable}): ${result.error.message}\n`)
    return 1
  }
  return result.status ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runPython()
}
