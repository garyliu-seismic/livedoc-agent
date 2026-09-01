/**
 * Local LLM Agent — Direct Fetch Implementation (No SDK)
 * 绕过 OpenAI Node SDK，直接处理 Qwen3/Ollama 的返回结构，解决兼容性卡死问题。
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL || "qwen3:latest"; 
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "http://localhost:11434/v1";
let _currentToken = ""; // Agent 内部维护 Token，供工具调用使用

export class LiveDocAgent {
  private messages: any[] = [];
  
  constructor(token: string) {
    _currentToken = token;
  }

  async chat(userMessage: string, toolExecutor: any) {
    this.messages.push({ role: "user", content: userMessage });

    // 调用 LLM (Qwen3) 获取意图/工具参数
    const response = await this.callLocalLLM();
    
    if (!response.tool_calls || response.tool_calls.length === 0) {
      // 如果没有工具调用，直接返回文字
      return { reply: response.content };
    }

    let agentReply = "";
    for (const tc of response.tool_calls) {
      const toolName = tc.name; 
      const rawArgs = JSON.parse(tc.arguments ?? "{}");
      
      // 在本地执行 MCP 工具逻辑
      const result = await toolExecutor(toolName, rawArgs);
      agentReply += `[Tool ${toolName} Result]: ${JSON.stringify(result).slice(0, 300)}\n\n`;
    }

    this.messages.push({ role: "assistant", content: agentReply });
    
    return { reply: agentReply }; // Agent 返回工具执行结果
  }

  async callLocalLLM() {
    const tools = [
      { 
        type: "function",
        function: {
          name: "search_templates",
          description: "Search Seismic content library for templates.",
          parameters: {
            type: "object",
            properties: {
              searchText: { type: "string" },
              pageSize: { type: "number" }
            },
            required: ["searchText"]
          }
        }
      },
      { 
        type: "function",
        function: {
          name: "get_form_schema",
          description: "Get inputs for a live doc template.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string" }
            },
            required: ["id"]
          }
        }
      }
    ];

    // 使用原生 fetch 调用 Ollama/Qwen3，完全避免 SDK 兼容性报错
    const res = await fetch(OPENAI_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          ...this.messages.slice(-10), // 上下文限制在 10 条
          { role: "assistant", content: "现在，请使用工具。回复为 JSON 格式（包含 tool_name）" }
        ],
        tools: tools
      })
    });

    const data = await res.json();
    if (!data?.choices?.[0]) return { content: "LLM 未返回内容", tool_calls: [] };

    const choice = data.choices[0].message;
    
    return {
      content: choice.content || "",
      // Ollama/Qwen3 的工具返回结构可能不同，这里做兼容处理
      tool_calls: (choice.tool_calls ?? []).map(tc => ({
        name: tc.function?.name,
        function: tc.function,
        arguments: tc.function?.arguments
      }))
    };
  }
}

// MCP Tools 封装（增加了对 Seismic API 的健壮处理）
export async function executeTools(toolName: string, args: any) {
  const token = _currentToken || process.env.SEISMIC_API_TOKEN;
  // ... (工具定义与 livedocRoutes.ts 类似，此处省略以节省篇幅)
  
  if (toolName === "search_templates") {
    try {
      const r = await fetch("https://api.seismic-dev.com/qa/livedoc/v3/contents", {
        method: "POST",
        headers: { "Authorization": "Bearer "+token, "Content-Type": "application/json" },
        body: JSON.stringify({ searchText: args.searchText, allowPptx: true })
      });
      const json = await r.json();
      return { results: json.results || [], totalCount: json.totalCount || 0 };
    } catch (e) { return { error: e.message }; }
  }
}
