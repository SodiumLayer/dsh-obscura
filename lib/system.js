/**
 * The few operating-system actions the panel can ask for.
 *
 * They live behind one module so the HTTP layer can be tested without opening a
 * real window, and so every path that reaches a shell command is visibly
 * validated here rather than at the call site.
 *
 * @module system
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Open a folder in the platform's file manager.
 *
 * The path is resolved first and must exist as a directory: the panel sends a
 * path back, and a path that is not a real directory is a bug or a probe, not
 * something to hand to `explorer.exe`.
 *
 * @param {string} dir - directory to open.
 * @param {{spawnImpl?: typeof spawn, platform?: string}} [deps] - injectable process access.
 * @returns {{opened: boolean, path: string, error?: string}} the outcome.
 */
export function openFolder(dir, deps = {}) {
  const platform = deps.platform ?? process.platform
  const spawnImpl = deps.spawnImpl ?? spawn
  const target = resolve(dir)
  try {
    if (!statSync(target).isDirectory()) return { opened: false, path: target, error: `${target} 不是一个目录` }
  } catch (error) {
    return { opened: false, path: target, error: `目录不存在或不可访问：${target}` }
  }

  try {
    if (platform === 'win32') {
      // `explorer.exe` returns a non-zero exit code even on success, so the child
      // is detached and its status deliberately ignored.
      const child = spawnImpl('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref?.()
      return { opened: true, path: target }
    }
    const command = platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawnImpl(command, [target], { detached: true, stdio: 'ignore' })
    child.unref?.()
    return { opened: true, path: target }
  } catch (error) {
    return { opened: false, path: target, error: `无法打开文件夹：${String(error)}` }
  }
}

/**
 * Whether a directory exists and can be written to — used to tell the user
 * whether dropping obscura.exe into the plugin's `bin/` folder will work.
 * @param {string} dir - directory to test.
 * @returns {boolean} true when writable.
 */
export function isDirectoryWritable(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}
