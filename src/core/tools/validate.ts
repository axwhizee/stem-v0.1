// ============================================================
// core/tools/validate.ts —— JSON Schema 子集参数校验（纯函数）
//
// 校验 ToolParametersSchema 声明的参数形状：
//   - input 必须是 object
//   - required 字段必须存在
//   - 属性类型匹配（string/number/boolean/array/object/null）
//   - enum 枚举约束
// 返回错误信息字符串；校验通过返回 undefined。
// ============================================================

import type { ToolParametersSchema, ToolPropertySchema } from './types'

export function validateArgs(input: unknown, schema: ToolParametersSchema): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return `参数必须是对象，收到 ${describeType(input)}`
  }
  const record = input as Record<string, unknown>

  for (const key of schema.required ?? []) {
    if (!(key in record) || record[key] === undefined) {
      return `缺少必填参数: ${key}`
    }
  }

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in record) || record[key] === undefined) continue
    const error = validateProperty(record[key], prop, key)
    if (error) return error
  }
  return undefined
}

function validateProperty(value: unknown, prop: ToolPropertySchema, path: string): string | undefined {
  const typeError = typeMismatch(value, prop.type)
  if (typeError) return `参数 ${path} 类型应为 ${prop.type}，收到 ${typeError}`

  if (prop.type === 'array' && prop.items) {
    const array = value as unknown[]
    for (let i = 0; i < array.length; i++) {
      const itemError = validateProperty(array[i]!, prop.items, `${path}[${i}]`)
      if (itemError) return itemError
    }
  }

  if (prop.enum !== undefined && !prop.enum.includes(value as never)) {
    return `参数 ${path} 不在允许的枚举值内: ${prop.enum.join(', ')}`
  }
  return undefined
}

function typeMismatch(value: unknown, type: ToolPropertySchema['type']): string | undefined {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? undefined : describeType(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : describeType(value)
    case 'boolean':
      return typeof value === 'boolean' ? undefined : describeType(value)
    case 'array':
      return Array.isArray(value) ? undefined : describeType(value)
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : describeType(value)
    case 'null':
      return value === null ? undefined : describeType(value)
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
