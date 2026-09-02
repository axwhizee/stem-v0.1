import { tool } from "@opencode-ai/plugin";
import { zhida } from "./_zhihu";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Mode → 云端 system-prompt 片段 ─────────────────────────────────────
// 存放在工具代码里，不进入本地 agent 上下文；agent 只选 mode，云端研究者收到完整 brief。
const MODES: Record<string, string> = {
  general:
    "综合多个相互独立的来源，客观总结共识与分歧，指出各来源的可信度差异。",
  news:
    "关注时效性：优先最近一周内的信息，为每条结论标注发布时间与来源。",
  deep_analysis:
    "进行多角度分析：列出支持方与反对方的论点，至少引用 3 个相互独立的来源，最后给出你的综合判断。",
  fact_check:
    "逐条核查给定的陈述，为每条分别标注『支持 / 反驳 / 无证据』并给出置信度（高/中/低）。",
};

const LANG_HINT: Record<string, string> = {
  zh: "请始终使用简体中文回答。",
  en: "Always answer in English.",
  auto: "请使用与研究问题相同的语言回答。",
};

const ZHIVA_MODELS = ["zhida-agent", "zhida-thinking-1p5", "zhida-fast-1p5"];

// ── DeepSeek Responses API（可选后端）────────────────────────────────

const DEEPSEEK_API_URL = "https://api.deepseek.com/responses";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const MAX_OUTPUT_TOKENS = 8192;

function resolveDeepSeekKey(): string | null {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const path = join(homedir(), ".local", "share", "opencode", "auth.json");
    if (!existsSync(path)) return null;
    const auth = JSON.parse(readFileSync(path, "utf-8"));
    const key = auth?.deepseek?.key;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

async function callDeepSeek(systemPrompt: string, query: string): Promise<string> {
  const apiKey = resolveDeepSeekKey();
  if (!apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY not found. Export it before launching opencode, or ensure a 'deepseek' entry exists in opencode's auth store.",
    );
  }
  const res = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      instructions: systemPrompt,
      input: query,
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
      reasoning: { effort: "low" },
      max_output_tokens: MAX_OUTPUT_TOKENS,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek API error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.status !== "completed") {
    const reason = body.error?.message ?? body.incomplete_details?.reason ?? body.status;
    return `[deepsearch] 云端研究未完成 (${body.status}): ${reason}`;
  }
  let text = "";
  for (const item of body.output ?? []) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "output_text" && typeof c.text === "string") text += c.text;
      }
    }
  }
  if (!text.trim()) return "[deepsearch] 云端模型未返回文本内容。";
  return ensureSourceSection(text);
}

// ── 知乎直答后端（默认）───────────────────────────────────────────────

async function callZhida(systemPrompt: string, query: string, model: string): Promise<string> {
  const { content, reasoning } = await zhida(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: query },
    ],
    model,
  );
  if (!content.trim()) return "[deepsearch] 知乎直答未返回文本内容。";
  // zhida 通常不返回链接列表；若模型在正文里给了链接则保留，否则附加说明。
  const out = ensureSourceSection(content);
  if (reasoning) {
    return `${out}\n\n---\n<details>\n<summary>思考过程（${model}）</summary>\n\n${reasoning.slice(0, 3000)}\n</details>`;
  }
  return out;
}

// ── 输出契约：保证有来源段 ────────────────────────────────────────────

function ensureSourceSection(text: string): string {
  const hasSourceHeading =
    /^#{1,6}\s*[^\n]*来源/m.test(text) ||
    /^#{1,6}\s*(sources|references|links)\b/im.test(text);
  if (hasSourceHeading) return text;
  const urls = Array.from(new Set(text.match(/https?:\/\/[^\s)"'}<>]+/g) ?? []));
  if (urls.length === 0) {
    return (
      text +
      "\n\n## 来源\n（知乎直答基于知乎内容库检索生成，未提供具体链接时请谨慎对待并另行核验）"
    );
  }
  return text + "\n\n## 来源\n" + urls.map((u) => `- ${u}`).join("\n");
}

// ── 工具定义 ──────────────────────────────────────────────────────────

export default tool({
  description:
    "将研究问题委托给外部研究者：默认使用知乎直答（zhida，基于知乎内容库检索增强，配置简单），也可切换 DeepSeek Responses 云端研究员（backend=deepseek）。返回自然语言综合答案，末尾尽量带『## 来源』供核验。成本高（每次调用一次外部模型），保留给多源研究、对比分析、新闻分析或事实核查；单个快速事实优先用 websearch/webfetch。参数：query、mode（general|news|deep_analysis|fact_check）、instructions（可选补充要求）、language（zh|en|auto）、backend（zhida|deepseek，默认 zhida）、model（zhida-agent|zhida-thinking-1p5|zhida-fast-1p5，默认 zhida-agent）。",

  args: {
    query: tool.schema
      .string()
      .describe("The research question to search and synthesize"),
    mode: tool.schema
      .string()
      .default("general")
      .describe("general | news | deep_analysis | fact_check"),
    instructions: tool.schema
      .string()
      .optional()
      .describe("Optional extra direction for the cloud researcher"),
    language: tool.schema
      .string()
      .default("auto")
      .describe("zh | en | auto - response language, auto follows the query"),
    backend: tool.schema
      .string()
      .default("zhida")
      .describe("zhida (default, 知乎直答) | deepseek (DeepSeek Responses)"),
    model: tool.schema
      .string()
      .default("zhida-agent")
      .describe(`zhida 模型: ${ZHIVA_MODELS.join(" | ")}`),
  },

  async execute(args) {
    const mode = MODES[args.mode] ?? MODES.general;
    const lang = LANG_HINT[args.language] ?? LANG_HINT.auto;

    const systemPrompt = [
      "你是一个拥有检索增强能力的研究助手。请依据检索到的真实信息回答，不得编造事实或来源。",
      mode,
      "回答末尾必须以 Markdown 二级标题『## 来源』逐条列出你引用的所有 URL，每行一个『- 标题: URL』；如果确实拿不到具体链接，就明确说明信息来源于知乎内容库。",
      lang,
      args.instructions ? `用户附加要求：${args.instructions}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    if ((args.backend ?? "zhida") === "deepseek") {
      return callDeepSeek(systemPrompt, args.query);
    }
    return callZhida(systemPrompt, args.query, args.model ?? "zhida-agent");
  },
});
