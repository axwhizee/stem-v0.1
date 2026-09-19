// ============================================================
// core/main/toolWiring.test.ts —— internal 定义 + drain 路径 + 工具记录 sink
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../gateway'
import { createKernelHarness } from '../../../test/support/kernelHarness'
import { createInternalToolDefs } from './toolWiring'
import { DefaultToolCapabilityRegistry } from '../tools'
import { ROOT_ID } from '../kernel'
import type { PilotEvent } from '../events'

describe('createInternalToolDefs + drain（与生产同路径）', () => {
  test('harness drain 后系统工具在册；bash 缺省不装配', async () => {
    const { tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')))
    const ids = (await tools.list()).map((t) => t.id)
    for (const id of [
      'agent_class_create',
      'agent_class_update',
      'agent_instantiate',
      'mail_send',
      'context_export',
      'telemetry_query',
    ]) {
      assert.ok(ids.includes(id), `缺 ${id}`)
    }
    assert.ok(!ids.includes('bash'), '宿主未注入 ShellRunner → 不装配 bash')
    assert.ok(tools.frozen(), 'harness drain 完成后工具表冻结')
  })

  test('注入 bash 端口 → defs 含 bash 且注册声明 allow', async () => {
    const { kernel } = await createKernelHarness(new FakeGateway(() => textEvents('ok')))
    const defs = createInternalToolDefs(kernel, {
      bash: { runner: { run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }) } },
    })
    const bash = defs.find((t) => t.id === 'bash')
    assert.ok(bash)
    assert.equal(bash.registerAccess, 'allow')
    const registry = new DefaultToolCapabilityRegistry()
    await registry.drain(defs, {})
    assert.ok((await registry.list()).some((t) => t.id === 'bash'))
  })
})

describe('attachToolRecordSink（harness 已接线；三相位 → 事件流 + 历史行）', () => {
  test('success 非挂起 → tool 事件 + tool 历史行', async () => {
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')))

    const toolEvents: PilotEvent[] = []
    kernel.events.subscribe((e) => {
      if (e.type === 'tool') toolEvents.push(e)
    })

    await tools.execute({ id: 'call_list', name: 'agent_class_list', input: {} }, { agentId: ROOT_ID })
    await new Promise((r) => setImmediate(r))

    assert.ok(
      toolEvents.some((e) => e.type === 'tool' && e.tool === 'agent_class_list' && e.phase === 'success'),
      `期望 agent_class_list success 事件，收到 ${JSON.stringify(toolEvents)}`,
    )

    const history = [...kernel.repository.list(ROOT_ID)]
    const lastTool = [...history].reverse().find((m) => m.message.role === 'tool')
    assert.ok(lastTool, '应有 tool 历史行')
  })
})
