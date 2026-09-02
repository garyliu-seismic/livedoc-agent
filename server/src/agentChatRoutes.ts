import { Router, Request, Response } from "express";
import dotenv from "dotenv";
import { TOOL_LIST, handleToolCall } from "./mcp-server.js";

dotenv.config();

const router = Router();
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "http://localhost:11434/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "qwen3:latest";
const MAX_TOOL_ROUNDS = 8;

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

const SYSTEM_PROMPT = `你是 Seismic LiveDoc 助手，通过工具帮用户搜索模板、查看表单、生成文档、查询状态、下载结果，或在字段复杂时打开网页表单让用户填写。

CRITICAL_RULES（必须严格遵守，优先级高于其他考虑）：
1. 只要用户的请求可以用现有工具处理（提到关键词、模板名、"找"、"搜索"、"生成"、"下载"、"查状态"等），必须立即调用对应工具；不要用文字反问或要求澄清来代替调用工具。
2. search_templates 的 searchText 直接取用户话里的关键词，不必等更多信息。
3. 只读查询链路（search_templates → get_template_form → poll_generation_status → download_generated_file）里，只要已有结果能推出下一步需要的参数（比如唯一匹配的 teamSiteId/versionId，或已知的 generatedLivedocId/outputId），就应该在同一轮对话里连续调用下一个工具，不要每一步都停下来问用户确认；只有信息不足以确定参数、或有多个匹配结果需要用户选择时才停下来问。
4. generate_live_doc 会产生真实副作用（提交生成任务），调用前必须已经从用户或表单结果里拿到明确的字段数据，不能用占位符或猜测的值填充。
5. 严禁自己拼接、猜测或臆造任何 URL（下载链接、表单链接、Workspace 链接等）。下载地址只能来自 download_generated_file 返回的 url 字段；表单链接只能来自 open_form_ui 返回的 url 字段；Workspace 文档链接只能来自 get_ucb_workspace_generation_status 返回的 workspaceUrl 字段。回复用户时必须原样复制，一个字符都不能改，也不能用 teamSiteId/versionId/blobId/fileId 等参数自己拼出新地址。如果还没调用过对应工具，就不要在回复里给出任何链接。
6. 字段较多或包含表格/变量列表等复杂结构的模板，不要在聊天里逐个字段追问用户，改为调用 open_form_ui 把链接给用户，请他们填完提交；不要在同一轮里紧接着调用 get_form_result（用户还没来得及填），等用户确认已提交、或用户主动询问进度时，再用 open_form_ui 返回的 token 调用 get_form_result。
7. 当用户想把文档生成到 Seismic Workspace（而不是下载文件）时，用 submit_ucb_workspace_generation；提交前必须先用 list_workspace_spaces/list_workspace_folders 拿到真实的 spaceId/folderId，origin.profileId/profileVersionId/contentLocation 优先从 search_templates 结果或 find_doccenter_profile 拿，拿不到就问用户，不能瞎填。提交后反复调用 get_ucb_workspace_generation_status 轮询直到 workspaceCommitted 为 true，再把 workspaceUrl 原样给用户。
8. 只有在调用工具后仍缺少必要参数时，才向用户提问。`;

// Keep short "grounding" reminders (real URLs/tokens) visible to the LLM even
// once the raw conversation grows past the recent-window cutoff below.
const RECENT_WINDOW = 20;

function buildLLMContext(context: any[]): any[] {
  const systemPrompt = context[0];
  const pinned = context.slice(1).filter(m => m.pinned);
  const recent = context.slice(-RECENT_WINDOW);
  const recentSet = new Set(recent);
  const extraPinned = pinned.filter(m => !recentSet.has(m));
  const combined = recent[0] === systemPrompt ? recent : [systemPrompt, ...extraPinned, ...recent];
  return combined.map(({ pinned, ...rest }: any) => rest);
}

function extractField(resultText: string, ...keys: string[]): string | null {
  try {
    const parsed = JSON.parse(resultText);
    for (const key of keys) {
      if (typeof parsed?.[key] === "string") return parsed[key];
    }
  } catch {
    // ignore
  }
  return null;
}

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
    let formUrl: string | null = null;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const isLastRound = round === MAX_TOOL_ROUNDS - 1;
        const choice = await callLLM(buildLLMContext(context), !isLastRound);

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

        const realUrls: string[] = [];

        for (const tc of choice.tool_calls) {
          const toolName = tc.function.name;
          console.log(`[Agent] Executing MCP Tool: ${toolName}`, tc.function.arguments);

          let resultText: string;
          try {
            const args = JSON.parse(tc.function.arguments || "{}");
            const result = await handleToolCall(toolName, args);
            resultText = JSON.stringify(result).slice(0, 4000);
            if (toolName === "download_generated_file") {
              const url = extractField(resultText, "url", "DownloadUrl");
              if (url) realUrls.push(url);
            }
            if (toolName === "open_form_ui") {
              const url = extractField(resultText, "url");
              if (url) {
                realUrls.push(url);
                formUrl = url;
              }
            }
            if (toolName === "get_ucb_workspace_generation_status") {
              const url = extractField(resultText, "workspaceUrl");
              if (url) realUrls.push(url);
            }
          } catch (err) {
            resultText = `Error: ${(err as Error).message}`;
          }

          context.push({ role: "tool", tool_call_id: tc.id, content: resultText });
        }

        if (realUrls.length > 0) {
          context.push({
            role: "system",
            content: `真实地址（必须原样复制，不能修改任何字符）：\n${realUrls.join("\n")}`,
            pinned: true,
          });
        }
      }
    } catch (e) {
      console.error("🔴 Qwen3 Ollama Error:", e);
      llmReply = `❌ AI Agent (${OPENAI_MODEL}) 响应失败。请确保 Ollama 正在运行且模型已加载。\n\n错误详情：${(e as Error).message}`;
    }

    (req.app as any).locals.conversations[sessionId] = context;

    res.json({ success: true, message: llmReply, toolsUsed, formUrl });
  } catch (err) {
    console.error("🔴 General Agent Error:", err);
    res.status(500).json({ error: "Internal Server Error", detail: (err as Error).message });
  }
});

export default router;
