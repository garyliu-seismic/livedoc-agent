import { Router, Request, Response } from "express";
import dotenv from "dotenv";
import { TOOL_LIST, handleToolCall } from "./mcp-server.js";
import { getConversation, saveConversation } from "./conversationStore.js";

dotenv.config();

const router = Router();
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "http://localhost:11434/v1";
// Ollama's OpenAI-compat /v1/chat/completions ignores think:false and always runs full
// chain-of-thought (~3s even for "say hi"); the native /api/chat endpoint honors it and
// is ~3x faster, so tool-calling loop traffic goes there instead of through /v1.
const OLLAMA_NATIVE_BASE_URL = OPENAI_BASE_URL.replace(/\/v1\/?$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "ornith-1.5:9b";
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

// Guard rail against the "查完模板顺手就生成" regression observed live (rule 4 alone wasn't
// reliable enough — the model auto-chained straight into generate_live_doc with fabricated
// data). These two tools are write/consequential, so they're simply not offered to the model
// at all unless the user has actually expressed generate/submit intent somewhere in this
// conversation — it can't call a tool it was never given.
const WRITE_TOOLS = new Set(["generate_live_doc", "submit_ucb_workspace_generation"]);
const GENERATE_INTENT_RE = /生成|提交|submit|generate/i;

function hasGenerateIntent(context: any[]): boolean {
  return context.some(m => m.role === "user" && GENERATE_INTENT_RE.test(String(m.content)));
}

const SYSTEM_PROMPT = `你是 Seismic LiveDoc 助手，通过工具帮用户搜索模板、查看表单、生成文档、查询状态、下载结果，或在字段复杂时打开网页表单让用户填写。

CRITICAL_RULES（必须严格遵守，优先级高于其他考虑）：
1. 只要用户的请求可以用现有工具处理（提到关键词、模板名、"找"、"搜索"、"生成"、"下载"、"查状态"等），必须立即调用对应工具；不要用文字反问或要求澄清来代替调用工具。
2. search_templates 的 searchText 直接取用户话里的关键词，不必等更多信息。
3. 只读查询工具（search_templates、get_template_form、poll_generation_status、download_generated_file、list_workspace_spaces、list_workspace_folders）之间，只要已有结果能推出下一步需要的参数（比如唯一匹配的 teamSiteId/versionId，或已知的 generatedLivedocId/outputId），就应该在同一轮对话里连续调用下一个工具，不要每一步都停下来问用户确认；只有信息不足以确定参数、或有多个匹配结果需要用户选择时才停下来问。这条规则只适用于只读工具，绝不适用于下一条里的写操作工具。
4. generate_live_doc / submit_ucb_workspace_generation 会产生真实副作用（提交生成任务），是完全独立的两个决定，严禁在 search_templates/get_template_form 之后自动连着调用——即使 rule 3 让你连续查询，查完就必须停下来。只有当用户在本轮对话里明确说了"生成"/"提交"/"submit"/"generate" 这类词，并且你已经从用户或表单结果里拿到了每一个必填字段的明确值时，才能调用；绝不能用样例值、占位符、或看起来合理但用户没说过的数据去猜。generatedLivedocId 只能是 generate_live_doc/submit_ucb_workspace_generation 自己返回的值，或用户明确告诉你的值，绝不能用 contentVersionId/teamSiteId 等其他 id 顶替。
5. 严禁自己拼接、猜测或臆造任何 URL（下载链接、表单链接、Workspace 链接等）。下载地址只能来自 download_generated_file 返回的 url 字段；表单链接只能来自 open_form_ui 返回的 url 字段；Workspace 文档链接只能来自 get_ucb_workspace_generation_status 返回的 workspaceUrl 字段。回复用户时必须原样复制，一个字符都不能改，也不能用 teamSiteId/versionId/blobId/fileId 等参数自己拼出新地址。如果还没调用过对应工具，就不要在回复里给出任何链接。
6. 字段较多或包含表格/变量列表等复杂结构的模板，不要在聊天里逐个字段追问用户，改为调用 open_form_ui 把链接给用户，请他们填完提交；不要在同一轮里紧接着调用 get_form_result（用户还没来得及填），等用户确认已提交、或用户主动询问进度时，再用 open_form_ui 返回的 token 调用 get_form_result。如果用户还提到了"保存到 workspace"/"UCB"等，调用 open_form_ui 时要一并传入 workspace（spaceId/folderId，来自 list_workspace_spaces/list_workspace_folders 的真实值）和 origin（profileId/profileVersionId/contentLocation，来自 search_templates 结果/find_doccenter_profile/用户提供），表单页面会自动识别并走 Workspace 提交流程；否则不要传 workspace/origin，表单走默认的下载生成流程。
7. 当用户直接在聊天里（不通过 open_form_ui 表单）提供字段值、想把文档生成到 Seismic Workspace 时，用 submit_ucb_workspace_generation；提交前必须先用 list_workspace_spaces/list_workspace_folders 拿到真实的 spaceId/folderId，origin.profileId/profileVersionId/contentLocation 优先从 search_templates 结果或 find_doccenter_profile 拿，拿不到就问用户，不能瞎填。spaceId/folderId/generationId 必须逐字使用 list_workspace_spaces/list_workspace_folders/submit_ucb_workspace_generation 真实返回过的值，严禁编造或从记忆里拼一个"看起来像"的 id；如果不确定某个 id 是否真实存在，重新调用对应工具确认，不要凭印象使用。提交后反复调用 get_ucb_workspace_generation_status 轮询直到 workspaceCommitted 为 true，再把 workspaceUrl 原样给用户。
8. 提交 generate_live_doc/submit_ucb_workspace_generation 前，如果 get_template_form 返回的某个必填字段用户没有明确提供，先根据字段名称、类型或模板里的默认值猜一个合理的默认值，明确告诉用户"我打算用 XX 作为 YY 字段的值，可以吗"并等待确认，不要直接拿空值/占位符硬提交导致报错，也不要不给建议就抛出"缺少信息"打回给用户。
9. 只有在调用工具后仍缺少必要参数时，才向用户提问。
10. 工具返回 error/detail 时，必须把 detail 里的具体字段名和报错原因原文（或翻译）直接告诉用户是哪个字段、什么值出了问题，不要让用户自己去猜"可能是 A，也可能是 B，也可能是 C"；如果 detail 指向某个具体参数（例如 workspace.spaceId、origin.profileId、outputs[0].regionalFormat），点名该参数并说明本次实际传了什么值、正确格式应该是什么。`;

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

// Last-resort safety net: prompt rules alone aren't reliable against a small local model
// (verified live — it fabricated a download URL pointing at our own frontend port with a
// copy-pasted id despite explicit "never construct a URL" rules). Strip any URL in the
// final reply that doesn't verbatim appear somewhere in this conversation's real tool
// results, rather than trust the model to have followed instructions.
function stripFabricatedUrls(reply: string, context: any[]): string {
  const knownText = context
    .filter(m => m.role === "tool" || m.pinned)
    .map(m => String(m.content))
    .join("\n");

  return reply.replace(/https?:\/\/[^\s"')\]]+/g, url => {
    return knownText.includes(url) ? url : "[链接已被移除：该地址未在任何工具的真实返回结果中出现，可能是模型编造的。请重新询问以获取真实链接。]";
  });
}

// Only safe to auto-retry idempotent/read-only tools — retrying a generate/submit call
// could create a duplicate real-world generation, so those always fail straight to the
// model instead.
const RETRYABLE_TOOLS = new Set([
  "search_templates", "get_template_form", "poll_generation_status", "download_generated_file",
  "list_workspace_spaces", "list_workspace_folders", "get_form_result",
  "get_ucb_workspace_generation_status", "find_doccenter_profile",
]);

async function withRetry<T>(fn: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
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

async function callLLM(messages: any[], useTools: boolean, allowWriteTools: boolean): Promise<any> {
  const tools = allowWriteTools ? TOOLS_SCHEMA : TOOLS_SCHEMA.filter(t => !WRITE_TOOLS.has(t.function.name));
  const resp = await fetch(OLLAMA_NATIVE_BASE_URL + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      think: false,
      ...(useTools ? { tools } : {}),
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
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

    const context = getConversation(sessionId);
    if (context.length === 0) {
      context.push({ role: "system", content: SYSTEM_PROMPT });
    }
    context.push({ role: "user", content: message });

    let llmReply = "";
    let toolsUsed = false;
    let formUrl: string | null = null;
    const allowWriteTools = hasGenerateIntent(context);

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const isLastRound = round === MAX_TOOL_ROUNDS - 1;
        const choice = await withRetry(() => callLLM(buildLLMContext(context), !isLastRound, allowWriteTools), 2, 800);

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
            const result = RETRYABLE_TOOLS.has(toolName)
              ? await withRetry(() => handleToolCall(toolName, args), 2, 500)
              : await handleToolCall(toolName, args);
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

    llmReply = stripFabricatedUrls(llmReply, context);

    saveConversation(sessionId, context);

    res.json({ success: true, message: llmReply, toolsUsed, formUrl });
  } catch (err) {
    console.error("🔴 General Agent Error:", err);
    res.status(500).json({ error: "Internal Server Error", detail: (err as Error).message });
  }
});

export default router;
