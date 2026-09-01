import { Router, Request, Response } from "express";
import dotenv from "dotenv";
import { TOOL_LIST, handleToolCall } from "./mcp-server.js";

dotenv.config();

const router = Router();
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "http://localhost:11434/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "qwen3:latest";
const MAX_TOOL_ROUNDS = 6;

// ====================== MCP -> OpenAI tool schema ======================
// TOOL_LIST / handleToolCall come from mcp-server.ts, the single source of truth
// for tool definitions — no more duplicating tool logic in the chat route.
const TOOLS_SCHEMA = TOOL_LIST.map(t => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.schema,
  },
}));

const SYSTEM_PROMPT =
  "你是 Seismic LiveDoc 助手。可以使用提供的工具搜索模板、查看表单字段、生成文档、查询生成状态并下载结果。" +
  "只要用户的请求能用现有工具直接处理（例如提到关键词、模板名、'找'、'搜索'、'生成'等），就必须立即调用对应工具，" +
  "不要仅用文字反问用户或要求澄清；search_templates 的 searchText 可以直接使用用户话里的关键词，不必等待更多信息。" +
  "只有在调用工具后仍缺少必要参数（例如 teamSiteId/versionId）时，才向用户提问。";

async function callLLM(messages: any[], useTools: boolean): Promise<any> {
  const resp = await fetch(OPENAI_BASE_URL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      ...(useTools ? { tools: TOOLS_SCHEMA, tool_choice: "auto" } : {}),
      stream: false,
    }),
  });
  if (!resp.ok) throw new Error(`Ollama API returned ${resp.status}`);
  const data = await resp.json();
  return data?.choices?.[0]?.message ?? null;
}

// ====================== Express Router ======================
router.post("/api/agent/chat/:sessionId", async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId;
    const { message } = req.body as { message: string };

    if (!message) return res.status(400).json({ error: "Missing 'message'" });

    const context = (req.app as any).locals.conversations[sessionId] ?? [];
    if (context.length === 0) {
      context.push({ role: "system", content: SYSTEM_PROMPT });
    }
    context.push({ role: "user", content: message });

    let llmReply = "";
    let toolsUsed = false;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const isLastRound = round === MAX_TOOL_ROUNDS - 1;
        const choice = await callLLM(context.slice(-20), !isLastRound);

        if (!choice) {
          llmReply = "Agent 未生成有效内容。";
          break;
        }

        if (!choice.tool_calls || choice.tool_calls.length === 0 || isLastRound) {
          llmReply = choice.content || "已达到最大工具调用轮数，请根据上方工具结果自行判断。";
          context.push({ role: "assistant", content: llmReply });
          break;
        }

        toolsUsed = true;
        context.push(choice); // assistant turn requesting tool_calls

        for (const tc of choice.tool_calls) {
          const toolName = tc.function.name;
          console.log(`[Agent] Executing MCP Tool: ${toolName}`, tc.function.arguments);

          let resultText: string;
          try {
            const args = JSON.parse(tc.function.arguments || "{}");
            const result = await handleToolCall(toolName, args);
            resultText = JSON.stringify(result).slice(0, 4000);
          } catch (err) {
            resultText = `Error: ${(err as Error).message}`;
          }

          context.push({ role: "tool", tool_call_id: tc.id, content: resultText });
        }
      }
    } catch (e) {
      console.error("🔴 Qwen3 Ollama Error:", e);
      llmReply = `❌ AI Agent (${OPENAI_MODEL}) 响应失败。请确保 Ollama 正在运行且模型已加载。\n\n错误详情：${(e as Error).message}`;
    }

    (req.app as any).locals.conversations[sessionId] = context;

    res.json({ success: true, message: llmReply, toolsUsed });
  } catch (err) {
    console.error("🔴 General Agent Error:", err);
    res.status(500).json({ error: "Internal Server Error", detail: (err as Error).message });
  }
});

export default router;
