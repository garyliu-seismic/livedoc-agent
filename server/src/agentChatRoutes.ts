import { Router, Request, Response } from "express";
import dotenv from "dotenv";
import { TOOL_LIST, handleToolCall } from "./mcp-server.js";

dotenv.config();

const router = Router();
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "http://localhost:11434/v1";
// Ollama's OpenAI-compat /v1/chat/completions ignores think:false and always runs full
// chain-of-thought (~3s even for "say hi"); the native /api/chat endpoint honors it and
// is ~3x faster, so tool-calling loop traffic goes there instead of through /v1.
const OLLAMA_NATIVE_BASE_URL = OPENAI_BASE_URL.replace(/\/v1\/?$/, "");
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
3. 只读查询工具（search_templates、get_template_form、poll_generation_status、download_generated_file、list_workspace_spaces、list_workspace_folders）之间，只要已有结果能推出下一步需要的参数（比如唯一匹配的 teamSiteId/versionId，或已知的 generatedLivedocId/outputId），就应该在同一轮对话里连续调用下一个工具，不要每一步都停下来问用户确认；只有信息不足以确定参数、或有多个匹配结果需要用户选择时才停下来问。这条规则只适用于只读工具，绝不适用于下一条里的写操作工具。
4. generate_live_doc / submit_ucb_workspace_generation 会产生真实副作用（提交生成任务），是完全独立的两个决定，严禁在 search_templates/get_template_form 之后自动连着调用——即使 rule 3 让你连续查询，查完就必须停下来。只有当用户在本轮对话里明确说了"生成"/"提交"/"submit"/"generate" 这类词，并且你已经从用户或表单结果里拿到了每一个必填字段的明确值时，才能调用；绝不能用样例值、占位符、或看起来合理但用户没说过的数据去猜。generatedLivedocId 只能是 generate_live_doc/submit_ucb_workspace_generation 自己返回的值，或用户明确告诉你的值，绝不能用 contentVersionId/teamSiteId 等其他 id 顶替。
5. 严禁自己拼接、猜测或臆造任何 URL（下载链接、表单链接、Workspace 链接等）。下载地址只能来自 download_generated_file 返回的 url 字段；表单链接只能来自 open_form_ui 返回的 url 字段；Workspace 文档链接只能来自 get_ucb_workspace_generation_status 返回的 workspaceUrl 字段。回复用户时必须原样复制，一个字符都不能改，也不能用 teamSiteId/versionId/blobId/fileId 等参数自己拼出新地址。如果还没调用过对应工具，就不要在回复里给出任何链接。
6. 字段较多或包含表格/变量列表等复杂结构的模板，不要在聊天里逐个字段追问用户，改为调用 open_form_ui 把链接给用户，请他们填完提交；不要在同一轮里紧接着调用 get_form_result（用户还没来得及填），等用户确认已提交、或用户主动询问进度时，再用 open_form_ui 返回的 token 调用 get_form_result。
7. 当用户想把文档生成到 Seismic Workspace（而不是下载文件）时，用 submit_ucb_workspace_generation；提交前必须先用 list_workspace_spaces/list_workspace_folders 拿到真实的 spaceId/folderId，origin.profileId/profileVersionId/contentLocation 优先从 search_templates 结果或 find_doccenter_profile 拿，拿不到就问用户，不能瞎填。spaceId/folderId/generationId 必须逐字使用 list_workspace_spaces/list_workspace_folders/submit_ucb_workspace_generation 真实返回过的值，严禁编造或从记忆里拼一个"看起来像"的 id；如果不确定某个 id 是否真实存在，重新调用对应工具确认，不要凭印象使用。提交后反复调用 get_ucb_workspace_generation_status 轮询直到 workspaceCommitted 为 true，再把 workspaceUrl 原样给用户。
8. 提交 generate_live_doc/submit_ucb_workspace_generation 前，如果 get_template_form 返回的某个必填字段用户没有明确提供，先根据字段名称、类型或模板里的默认值猜一个合理的默认值，明确告诉用户"我打算用 XX 作为 YY 字段的值，可以吗"并等待确认，不要直接拿空值/占位符硬提交导致报错，也不要不给建议就抛出"缺少信息"打回给用户。
9. 只有在调用工具后仍缺少必要参数时，才向用户提问。`;

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
  const resp = await fetch(OLLAMA_NATIVE_BASE_URL + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      think: false,
      ...(useTools ? { tools: TOOLS_SCHEMA } : {}),
      stream: false,
    }),
  });
  if (!resp.ok) throw new Error(`Ollama API returned ${resp.status}`);
  const data = await resp.json();
  return data?.message ?? null;
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
        const formTokens: string[] = [];

        for (const tc of choice.tool_calls) {
          const toolName = tc.function.name;
          console.log(`[Agent] Executing MCP Tool: ${toolName}`, tc.function.arguments);

          let resultText: string;
          try {
            // Ollama's native /api/chat returns arguments as an already-parsed object
            // (unlike the OpenAI-compat layer, which sends a JSON string).
            const rawArgs = tc.function.arguments;
            const args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
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
              const token = extractField(resultText, "token");
              if (token) formTokens.push(token);
            }
            if (toolName === "get_ucb_workspace_generation_status") {
              const url = extractField(resultText, "workspaceUrl");
              if (url) realUrls.push(url);
            }
          } catch (err) {
            resultText = `Error: ${(err as Error).message}`;
          }

          context.push({ role: "tool", tool_call_id: tc.id, content: resultText });

          // These carry real ids (spaceId/folderId/generationId) the model must reuse
          // verbatim in later tool calls — pin them so a long conversation doesn't push
          // them out of the recent-window and cause the model to invent/misremember one.
          if (["list_workspace_spaces", "list_workspace_folders", "submit_ucb_workspace_generation"].includes(toolName)) {
            context.push({
              role: "system",
              content: `${toolName} 的真实结果（后续引用其中的 id 时必须原样使用，不能编造）：\n${resultText}`,
              pinned: true,
            });
          }
        }

        if (realUrls.length > 0) {
          context.push({
            role: "system",
            content: `真实地址（必须原样复制，不能修改任何字符）：\n${realUrls.join("\n")}`,
            pinned: true,
          });
        }

        if (formTokens.length > 0) {
          context.push({
            role: "system",
            content: `open_form_ui 返回的 token（用户确认提交后调用 get_form_result 时直接用这个值，不要去 URL 里解析）：\n${formTokens.join("\n")}`,
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
