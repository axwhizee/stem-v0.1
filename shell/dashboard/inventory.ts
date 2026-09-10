// ============================================================
// shell/dashboard/inventory.ts —— 三态资源清单（标本装配）
//
// 不造第二套清册：清单 = `bootStem({stateStore:false})` 纯内存标本的
// 真实装配结果——runInit 矩阵装载（extension 点名 + custom 扫描 + init
// issues）+ registry.materialize(root) 的生效可见集 + 族谱模型解析，
// 所见即所跑。标本常驻（无信件即零 LLM 成本），refresh 重建。
// ============================================================

import { bootStem } from '../cli/platform'
import { existsSync } from 'node:fs'
import { BUILTIN_TEMPLATES, ROOT_ID } from '../../src/core/kernel'
import { createBuiltinStrategyRegistry } from '../../src/core/context'
import type { AgentClass } from '../../src/core/kernel'
import type { ToolCapability } from '../../src/core/tools'
import type { StemSystem } from '../../src/core/main'
import type { InitIssue } from '../../src/core/main'

export interface InventoryTool {
  readonly id: string
  readonly kind: string
  readonly accessKey: string
  readonly description: string
  readonly visibleToRoot: boolean
  readonly category?: string
}

export interface InventoryClass {
  readonly name: string
  readonly layer: 'internal' | 'extension' | 'custom' | 'runtime'
  readonly description: string
  readonly model?: string
  readonly toolKeys: number
  readonly panel: boolean
}

export interface InventoryStrategy {
  readonly name: string
  readonly layer: 'internal' | 'extension' | 'custom'
  readonly note?: string
  /** 是否实现了 process（异步重活许可，compact 类策略标志）。 */
  readonly hasProcess: boolean
  /** 动作面（runContextAction 可调）。 */
  readonly actions: readonly string[]
}

export interface Inventory {
  readonly projectRoot: string
  readonly tools: InventoryTool[]
  readonly classes: InventoryClass[]
  readonly strategies: InventoryStrategy[]
  readonly providers: Record<string, { baseUrl: string; keyEnv?: string; models?: readonly string[]; keyPresent: boolean }>
  readonly homeModel?: string
  readonly extensions: unknown
  readonly initIssues: readonly InitIssue[]
  readonly assembledAt: number
}

interface Holder {
  system: StemSystem
  inventory: Inventory
}

let holder: Holder | undefined

const BUILTIN_NAMES = new Set<string>(['user', ...BUILTIN_TEMPLATES.map((t) => String(t.name))])

async function assemble(projectRoot: string): Promise<Holder> {
  const system = await bootStem({ projectRoot, stateStore: false }).then((r) => r.system)
  const tools: InventoryTool[] = []
  const visible = new Set(system.tools.materialize(ROOT_ID).map((d) => d.name))
  for (const t of (await system.tools.list()) as ToolCapability[]) {
    tools.push({
      id: t.id,
      kind: t.kind ?? 'internal',
      accessKey: t.accessKey ?? t.id,
      description: t.description.slice(0, 160),
      visibleToRoot: visible.has(t.id),
      ...(t.category !== undefined ? { category: t.category } : {}),
    })
  }
  const layerOf = new Map<string, 'extension' | 'custom'>(system.init.agents.map((a) => [a.id, a.layer]))
  const classes: InventoryClass[] = (await system.kernel.templates.list()).map((c: AgentClass) => ({
    name: String(c.name),
    layer: layerOf.get(String(c.name)) ?? (BUILTIN_NAMES.has(String(c.name)) ? 'internal' : 'runtime'),
    description: (c.description ?? '').slice(0, 160),
    ...(c.model !== undefined ? { model: `${c.model.provider}/${c.model.id}` } : {}),
    toolKeys: Object.keys(c.tools ?? {}).length,
    panel: c.panel === true,
  }))
  const env = process.env
  // 策略层判定：内置集从注册表构造器派生（不硬编码名单）；目录命中 = custom/extension
  const registry = system.kernel.contextManager.strategies
  const builtinStrategies = new Set(createBuiltinStrategyRegistry().names())
  const extContextRoot = new URL('../../extension/context', import.meta.url).pathname
  const strategies: InventoryStrategy[] = registry.names().map((name: string) => {
    const mod = registry.resolve(name)
    const custom = existsSync(`${projectRoot}/.stem/context/${name}.ts`) || existsSync(`${projectRoot}/.stem/context/${name}`)
    return {
      name,
      layer: custom ? 'custom' : (!builtinStrategies.has(name) && existsSync(`${extContextRoot}/${name}`) ? 'extension' : 'internal'),
      ...(mod?.note !== undefined ? { note: mod.note.slice(0, 120) } : {}),
      hasProcess: mod?.process !== undefined,
      actions: Object.keys(mod?.actions ?? {}),
    }
  })
  const providers: Inventory['providers'] = {}
  for (const [name, p] of Object.entries(system.config.providers ?? {})) {
    providers[name] = {
      baseUrl: p.base_url,
      ...(p.key_env !== undefined ? { keyEnv: p.key_env, keyPresent: (env[p.key_env] ?? '').length > 0 } : { keyPresent: true }),
      ...(p.models !== undefined ? { models: p.models } : {}),
    }
  }
  const inventory: Inventory = {
    projectRoot,
    tools,
    classes,
    strategies,
    providers,
    ...(system.config.user?.model !== undefined ? { homeModel: `${system.config.user.model.provider}/${system.config.user.model.id}` } : {}),
    extensions: system.config.extensions ?? null,
    initIssues: system.init.issues,
    assembledAt: Date.now(),
  }
  return { system, inventory }
}

/** 取清单（懒建标本常驻；refresh = 销毁重建）。 */
export async function getInventory(projectRoot: string, refresh = false): Promise<Inventory> {
  if (!refresh && holder !== undefined && holder.inventory.projectRoot === projectRoot) return holder.inventory
  if (holder !== undefined) void holder.system.dispose().catch(() => {})
  holder = await assemble(projectRoot)
  return holder.inventory
}
