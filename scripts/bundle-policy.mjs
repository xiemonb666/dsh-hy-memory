/** Filename/path safeguards shared by build and installation. This is not content scanning. */
export function isPrivateBundlePath(path) {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
  const name = parts.at(-1) ?? ''
  return parts.some(part => /^(?:data|db|database|env|\.venv|venv|node_modules|__pycache__)$/i.test(part))
    || /^\.env/i.test(name)
    || /\.env(?:\.|$)/i.test(name)
    || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i.test(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name)
    || /^(?:credentials|secrets?)(?:[._-]|$)/i.test(name)
    || /^(?:access[-_]token|api[-_]key)(?:[._-]|$)/i.test(name)
    || /^(?:worker-token|ui-token)(?:[._-]|$)/i.test(name)
}
