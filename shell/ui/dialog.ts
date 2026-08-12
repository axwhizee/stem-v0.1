// ============================================================
// shell/ui/dialog.ts —— 面板弹窗模块（可复用，队列结构）
//
// 弹窗由「主题、正文、选项（可多选）」组成，队列允许依次处理
// 多种弹窗（权限确认、未来通知/确认等复用同一接口）。
//
// 交互（CLI 面板）：每个选项编号，用户输入数字选择；多选用
// 逗号分隔（如 "1,3"）。
// ============================================================

export interface DialogOption {
  readonly id: string
  readonly label: string
}

export interface DialogRequest {
  readonly title: string
  readonly body: string
  readonly options: readonly DialogOption[]
  readonly multiple?: boolean
}

export type DialogResult = readonly string[]

interface PendingDialog {
  readonly request: DialogRequest
  readonly resolve: (result: DialogResult) => void
}

export interface ActiveDialog {
  readonly request: DialogRequest
  readonly resolve: (result: DialogResult) => void
}

/** 队列弹窗：同时到达的多个弹窗排队，依次激活等待用户选择。 */
export class QueueDialog {
  private readonly queue: PendingDialog[] = []
  private activeDialog: ActiveDialog | undefined

  /** 是否有正在等待用户输入的弹窗。 */
  get active(): boolean {
    return this.activeDialog !== undefined
  }

  get activeRequest(): DialogRequest | undefined {
    return this.activeDialog?.request
  }

  get pendingCount(): number {
    return this.queue.length
  }

  /** 入队一个弹窗，返回选择结果（Promise 在用户选择后 resolve）。空闲时立即激活。 */
  push(request: DialogRequest): Promise<DialogResult> {
    return new Promise<DialogResult>((resolve) => {
      this.queue.push({ request, resolve })
      this.activate()
    })
  }

  /** 弹起下一个弹窗（空闲时）。返回是否有弹窗被激活。 */
  activate(): boolean {
    if (this.activeDialog) return true
    const next = this.queue.shift()
    if (!next) return false
    this.activeDialog = { request: next.request, resolve: next.resolve }
    return true
  }

  /** 用户提交选择（选项 id 列表）；自动激活下一个弹窗。 */
  submit(selected: DialogResult): void {
    const current = this.activeDialog
    this.activeDialog = undefined
    current?.resolve(selected)
    this.activate()
  }

  /** 取消当前弹窗（reject：空选择）。 */
  cancel(): void {
    this.submit([])
  }
}

/** 渲染弹窗（CLI 文本）：主题 / 正文 / 编号选项。 */
export function formatDialog(request: DialogRequest): string {
  const lines = [
    `───── ${request.title} ─────`,
    request.body,
    ...request.options.map((option, index) => `  ${index + 1}. ${option.label}`),
    request.multiple ? '输入编号（多选用逗号分隔）:' : '输入编号:',
  ]
  return lines.join('\n')
}

/** 解析用户输入为选项 id 列表；无效输入返回 null。 */
export function parseSelection(input: string, request: DialogRequest): string[] | null {
  const raw = input.trim()
  if (raw === '') return null
  const indexes = raw.split(',').map((part) => part.trim())
  const ids: string[] = []
  for (const part of indexes) {
    if (!/^\d+$/.test(part)) return null
    const index = Number(part)
    if (index < 1 || index > request.options.length) return null
    const option = request.options[index - 1]
    if (option) ids.push(option.id)
  }
  if (ids.length === 0) return null
  if (!request.multiple && ids.length > 1) return null
  return ids
}
