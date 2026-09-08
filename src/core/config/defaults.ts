// ============================================================
// core/config/defaults.ts —— 首启自举模板（唯一"预设"的合法形态 = 数据）
//
// S6/R2：代码零端点常量——opencode zen 免费清单等一切"预设"只存在于
// 本模板文本；新空间首启落盘后即普通 config（用户可整体改写/删除）。
// 同时它也是**内存缺省配置**：config 文件不存在时的 in-memory 等效物
// （首启链路：load 不存在 → 本配置装配系统 → runInit 写出模板文件）。
// ============================================================

import { parseConfigText } from './parse'
import type { StemConfig } from './types'

/** 首启模板文本（必须保持 schema-clean：defaultStemConfig 全量校验通过）。 */
export const DEFAULT_CONFIG_TEXT = `{
  // stem 唯一配置文件（.stem = 世界：配置/类/工具/上下文策略/DB 皆在本目录）。
  // agent 类/上下文策略**目录即真相**：放进 .stem/agent/、.stem/context/ 即
  // 自动装载（用户主权书写面）；工具改为下方 extensions.tools 点名制（未点名
  // = 不存在，代码注入面闭合）。
  //
  // providers —— 模型提供商注册表（零兜底：端点全部 config 声明，代码无预设）。
  //   base_url：OpenAI 兼容端点（实际 POST {base_url}/chat/completions，请求发裸模型 id）
  //   key_env： 密钥所在**环境变量名**（配置文件永不承载明文密钥；缺省 = 匿名/本地端点）
  //   models：  启用白名单（空数组 = 全启用）
  // 下面唯一预设条目只是模板数据——复制本块即可接入任意兼容端点，例如：
  //   "alibaba": { "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  //                "key_env": "ALIBABA_API_KEY", "models": ["qwen3.8-flash", "qwen3.8-max"] }
  "providers": {
    "opencode-go": { "base_url": "https://opencode.ai/zen/go/v1", "key_env": "OPENCODE_API_KEY" }
  },
  // 根（user#0）的类配置：name = 出生称呼（缺省 'user'，全名 user#0——名字全局
  //   唯一，这是你的根在族谱里的称呼）。model = **家学锚点**（必填）：全体 agent
  //   的模型解析链 显式（实例化/agent_update）> 类基因 > 父继承 > 家学（本值）。
  // tools = 根收敛清单（收敛链第一环：键即白名单，未列一律 deny——缺席 ≠ 否决，
  //   不锁子孙显式申请；逐键被注册表出生值封顶）。下面是写好的推荐值，按你的
  //   主权增删（access_reply 保持 allow，缺位系统拒启——ask 审批闭环的答复义务）。
  "user": {
    // "name": "user",
    "model": "opencode-go/deepseek-v4-flash",
    "tools": {
      "access_reply": "allow",
      "bash": "allow",
      "websearch": "allow",
      "webfetch": "allow",
      "agent_instantiate": "allow",
      "agent_list": "allow",
      "agent_inspect": "allow",
      "agent_ancestry": "allow",
      "agent_descendants": "allow",
      "agent_class_list": "allow",
      "agent_update": "ask",
      "mail_send": "allow",
      "mail_participants": "allow",
      "telemetry_query": "allow",
      "context_overview": "allow",
      "context_export": "allow",
      "context_remove": "allow",
      "context_edit": "allow",
      "context_apply": "allow",
      "cortex_add_note": "allow",
      "cortex_del_note": "allow",
      "agent_class_create": "ask",
      "agent_class_update": "ask",
      "agent_terminate": "ask"
    }
  },
  "autoApprove": false,
  // 上下文策略（classic compact 参数面；summarizeModel 缺省 = 摘要 worker 继承宿主模型）。
  "context": { "window": 128000, "compact": { "enabled": true, "threshold": 0.8, "keepRecentTurns": 3 } },
  // bash 工具（缺省内置：120s 超时 / 50k 截断 / 项目根目录）。
  // "bash": { "defaultTimeoutMs": 120000, "maxOutputChars": 50000 },
  // 资源点名（装载与出生一句话说完）：tools = {名: 权限词}——名字在
  //   extension/tools/ 或 .stem/tools/ 解析不到 = 拒启；未点名的工具不存在于
  //   世界（.stem/tools/ 目录自动扫描已废止，注入面闭合）。缺省 = 纯 bash 最小系统。
  //   agent/context = extension/<键>/ 下条目名数组（缺省不启用）。
  "extensions": {
    "tools": {
      "read": "allow", "write": "allow", "edit": "allow", "grep": "allow", "glob": "allow"
      // 联网信息面按需点名：  "websearch": "allow", "webfetch": "allow"
    }
    // "agent": ["creator"],
  },
  "sendCountdown": 1000
}
`

/** 模板的解析产物（config 文件不存在时的内存缺省——首启链路与装配层共用）。 */
export function defaultStemConfig(): StemConfig {
  return parseConfigText(DEFAULT_CONFIG_TEXT, 'DEFAULT_CONFIG_TEXT')
}
