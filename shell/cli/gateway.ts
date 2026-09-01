// ============================================================
// shell/cli/gateway.ts —— provider 网关装配 + 路由（S6/R1 宿主门面）
//
// 零兜底纪律（docs/s6-plan.md R1/R2/R13）：
//   - 端点/密钥/白名单全部来自 config.providers（宿主读 env 注入，core 零平台）；
//   - key_env 未命中 = **启动 warn 点名**（不印值）+ provider 不接通；
//   - 未接通/未注册的 provider 被**实际用到才硬错**（GatewayError，文案可行动）；
//   - 产品路径无 mock——离线冒烟把 mockSse 作为普通匿名 provider 写进测试 config。
// ============================================================

import {
  createOpenAiCompatibleGateway,
  GatewayError,
  type ModelGateway,
} from '../../src/core/gateway'
import type { StemConfig } from '../../src/core/config'

export interface BuiltGateway {
  readonly gateway: ModelGateway
  /** 接通概览（/source 与健康检查展示）。 */
  readonly source: string
  /** 启动告警（key_env 未命中等，宿主负责 console.warn）。 */
  readonly warnings: readonly string[]
  /** 实际接通的 provider 名（有序）。 */
  readonly wired: readonly string[]
}

/** 按 config.providers 逐条建网关，返回按 request.model.provider 路由的门面。 */
export function buildGateway(config: StemConfig, env: NodeJS.ProcessEnv): BuiltGateway {
  const warnings: string[] = []
  const routes = new Map<string, ModelGateway>()
  /** 未接通原因（provider → 可行动文案；用到才抛，R1 两段式第二段）。 */
  const unwired = new Map<string, string>()
  const wired: string[] = []

  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    const apiKey = provider.key_env !== undefined ? env[provider.key_env] : undefined
    if (provider.key_env !== undefined && (apiKey === undefined || apiKey === '')) {
      const reason =
        `provider "${name}" 未接通：环境变量 $${provider.key_env} 未设置` +
        `（config providers.${name}.key_env 声明；修复：export ${provider.key_env}=<key> 或改配置）`
      warnings.push(reason)
      unwired.set(name, reason)
      continue
    }
    routes.set(
      name,
      createOpenAiCompatibleGateway({
        baseUrl: provider.base_url,
        ...(apiKey !== undefined && apiKey !== '' ? { apiKey } : {}),
        ...(provider.models !== undefined ? { models: provider.models } : {}),
      }),
    )
    wired.push(name)
  }

  const gateway: ModelGateway = {
    async * chat(request, options) {
      const target = routes.get(request.model.provider)
      if (target) {
        yield* target.chat(request, options)
        return
      }
      const reason =
        unwired.get(request.model.provider) ??
        `provider "${request.model.provider}" 未在 config providers 注册（已接通：${wired.length > 0 ? wired.join(', ') : '无'}）`
      throw new GatewayError({ kind: 'provider_unwired', message: reason })
    },
  }

  const source = wired.length > 0 ? `providers: ${wired.join(', ')}` : '（无已接通 provider——所有 LLM 调用将硬错）'
  return { gateway, source, warnings, wired }
}
