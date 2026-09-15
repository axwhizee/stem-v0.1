// ============================================================
// core/main/toolWiring.test.ts —— internal 装配 + 工具记录 sink 接线
// ============================================================

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeGateway, textEvents } from '../gateway'
import { createKernelHarness } from '../../../test/support/kernelHarness'
import { registerInternalTools } from './toolWiring'
import { ROOT_ID } from '../kernel'
import type { PilotEvent } from '../events'

describe('registerInternalTools（组合根装配）', () => {
  test('缺省注入 → 系统工具全量在册；bash 缺省不装配', async () => {
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')))
    await registerInternalTools(kernel, tools)
    const ids = (await tools.list()).map((t) => t.id)
    for (const id of [
      'agent_class_create',
      'agent_class_update',
      'agent_instantiate',
      'mail_send',
      'context_export',
      'telemetry_query',
      'access_reply',
    ]) {
      assert.ok(ids.includes(id), `缺 ${id}`)
    }
    assert.ok(!ids.includes('bash'), '宿主未注入 ShellRunner → 不装配 bash')
  })

  test('注入 bash 端口 → bash 在册且出生 allow', async () => {
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')))
    await registerInternalTools(kernel, tools, {
      bash: { runner: { run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }) } },
    })
    const bash = await tools.get('bash')
    assert.equal(bash.birth, 'allow')
  })
})

describe('attachToolRecordSink（harness 已接线；三相位 → 事件流 + 历史行）', () => {
  test('success 非挂起 → tool 事件 + tool 历史行', async () => {
    const { kernel, tools } = await createKernelHarness(new FakeGateway(() => textEvents('ok')))
    await registerInternalTools(kernel, tools)

    const toolEvents: PilotEvent[] = []
    kernel.events.subscribe((e) => {
      if (e.type === 'tool') toolEvents.push(e)
    })

    await tools.execute(
      { id: 'call_list', name: 'agent_class_list', input: {} },
      { agentId: ROOT_ID },
    )
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
