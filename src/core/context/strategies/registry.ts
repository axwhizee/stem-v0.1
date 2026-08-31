// ============================================================
// core/context/strategies/registry.ts —— 策略注册表
//
// name → ContextStrategyModule（内置 classic/none；init 管线可注册
// `.stem/context/*.ts` 用户策略——"让 agent 自己写策略"的加载通道）。
// 未知策略名解析失败（注册期 fail-fast；恢复路径除外，见 ContextManager）。
// ============================================================

import type { ContextStrategyModule } from './types'

export interface StrategyRegistry {
  /** 注册策略模块（同名覆盖内置 = 用户主权；重复注册幂等替换）。 */
  readonly register: (module: ContextStrategyModule) => void
  readonly has: (name: string) => boolean
  /** 解析策略名（undefined → 缺省策略；未知 → undefined 由调用方决定报错/兜底）。 */
  readonly resolve: (name: string | undefined) => ContextStrategyModule | undefined
  readonly names: () => readonly string[]
}

export class DefaultStrategyRegistry implements StrategyRegistry {
  private readonly modules = new Map<string, ContextStrategyModule>()

  constructor(
    modules: readonly ContextStrategyModule[] = [],
    private readonly defaultName: string = 'classic',
  ) {
    for (const module of modules) this.modules.set(module.name, module)
  }

  register(module: ContextStrategyModule): void {
    this.modules.set(module.name, module)
  }

  has(name: string): boolean {
    return this.modules.has(name)
  }

  resolve(name: string | undefined): ContextStrategyModule | undefined {
    if (name === undefined) return this.modules.get(this.defaultName)
    return this.modules.get(name)
  }

  names(): readonly string[] {
    return [...this.modules.keys()]
  }
}
