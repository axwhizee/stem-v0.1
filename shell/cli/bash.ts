// ============================================================
// shell/cli/bash.ts —— 节点 ShellRunner 实现（平台能力）
//
// core 只定义 bash 工具与 ShellRunner 端口；本文件是宿主侧的
// 唯一实现（child_process），经 bootStem 注入系统。缺省 shell
// 二进制 = 'bash'（config.bash.path 可覆盖），缺省工作目录 =
// 项目根（事故半径三机制之一；超时/截断在 core 工具层与端口
// 约定内共同完成）。
// ============================================================

import { spawn } from 'node:child_process'
import type { ShellRunOptions, ShellRunner } from '../../src/core/tools'

export interface NodeShellRunnerOptions {
  /** 缺省工作目录（run 未给 cwd 时使用；典型 = 项目根）。 */
  readonly defaultCwd?: string
  /** 缺省 shell 二进制（run 未给 shell 时使用；缺省 'bash'）。 */
  readonly defaultShell?: string
}

export function createNodeShellRunner(opts: NodeShellRunnerOptions = {}): ShellRunner {
  const defaultShell = opts.defaultShell ?? 'bash'
  return {
    run: (options: ShellRunOptions) =>
      new Promise((resolve, reject) => {
        const child = spawn(options.shell ?? defaultShell, ['-c', options.command], {
          cwd: options.cwd ?? opts.defaultCwd,
          windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, options.timeoutMs)
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        // spawn 失败（二进制不存在 / cwd 非法等）→ reject（registry 兜底 execution_failed）。
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ stdout, stderr, exitCode: timedOut ? null : code, timedOut })
        })
      }),
  }
}
