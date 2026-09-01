/**
 * MCP (Model Context Protocol) Server registration.
 * 
 * This file creates a standard MCP server that registers all the Seismic LiveDoc tools
 * so that a local LangChain Agent can discover and call them dynamically — instead of
 * having hardcoded endpoints in the frontend.
 * 
 * MCP protocol supports:
 * - Tool discovery (list_tools, get tool schemas)
 * - Dynamic routing (agent chooses which tool to call based on user intent)
 * - Parameter inference (LLM extracts arguments from natural language)
 */

interface MCPTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

import {
  searchTemplates,
  getTemplateForm,
  generateLiveDoc,
  pollGenerationStatus,
  setGenerationResult,
  getGenerationResult,
  downloadGeneratedFile,
  openFormUi,
} from "./mcp-tools.js";

// ================================================================
// MCP Tool Definitions (schema for langchain / mcp-sdk)
// ================================================================

export const TOOL_LIST: MCPTool[] = [
  {
    name: "search_templates",
    description: "Search Seismic content library for templates matching user query. Use when user asks to 'find a template', 'search for slides', etc.",
    schema: {
      type: "object",
      properties: {
        searchText: { type: "string", description: "Keywords or question to match against template titles/descriptions" },
        page: { type: "integer", description: "Page number (0-indexed)", default: 0 },
        pageSize: { type: "integer", description: "Number of results per page (max 50)", default: 10 },
      },
    },
  },
  {
    name: "get_template_form",
    description: "Get the form definition for a template so you know which fields need to be filled. Use when user has selected or referenced a specific template.",
    schema: {
      type: "object",
      properties: {
        teamSiteId: { type: "string", description: "The template's teamSiteId" },
        versionId: { type: "string", description: "The template's contentVersionId (version)" },
      },
    },
  },
  {
    name: "generate_live_doc",
    description: "Submit a LiveDoc generation request with filled form data. Use when user says 'generate', 'create', or 'submit' the document.",
    schema: {
      type: "object",
      properties: {
        teamSiteId: { type: "string" },
        versionId: { type: "string" },
        data: { 
          type: "object", 
          description: "Filled form values keyed by field id — LLM MUST extract these from the conversation or user's explicit instructions" 
        },
      },
    },
  },
  {
    name: "poll_generation_status",
    description: "Check the current status and outputs of a generated LiveDoc. Use when asked 'is it done?', 'status', or after generation to get download links.",
    schema: {
      type: "object",
      properties: {
        generatedLivedocId: { type: "string" },
      },
    },
  },
  {
    name: "download_generated_file",
    description: "Get the real, signed download URL for one completed output of a generated LiveDoc. Call this before giving the user any download link — NEVER construct or guess a download URL yourself.",
    schema: {
      type: "object",
      properties: {
        generatedLivedocId: { type: "string" },
        outputId: { type: "string", description: "The output's id, from poll_generation_status results" },
      },
      required: ["generatedLivedocId", "outputId"],
    },
  },
  {
    name: "open_form_ui",
    description: "For templates with many or complex fields, open the real form page in the user's browser instead of collecting field values through chat. Returns a URL to share with the user and a token. Do NOT wait for the user here — tell them to fill it out and come back, or check later with get_form_result.",
    schema: {
      type: "object",
      properties: {
        teamSiteId: { type: "string" },
        versionId: { type: "string" },
        context: { type: "string", description: "The user's original generation request, for context" },
        prefillValues: { type: "object", description: "Optional known field values to pre-fill" },
      },
      required: ["teamSiteId", "versionId"],
    },
  },
  {
    name: "get_form_result",
    description: "Check whether the user has submitted the form opened via open_form_ui. Call this on a later turn (after the user confirms they submitted, or when they ask about status) — do not call it immediately after open_form_ui.",
    schema: {
      type: "object",
      properties: {
        token: { type: "string", description: "The token returned by open_form_ui" },
      },
      required: ["token"],
    },
  },
];

// ================================================================
// Tool execution dispatcher (called by langchain agent)
// ================================================================

export async function handleToolCall(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case "search_templates":
      return searchTemplates({
        searchText: String(args.searchText ?? ""),
        page: Number(args.page ?? 0),
        pageSize: Number(args.pageSize ?? 10),
      });

    case "get_template_form":
      return getTemplateForm({
        teamSiteId: String(args.teamSiteId!),
        versionId: String(args.versionId!),
      });

    case "generate_live_doc":
      return generateLiveDoc({
        teamSiteId: String(args.teamSiteId!),
        versionId: String(args.versionId!),
        data: (args.data as Record<string, unknown>) ?? {},
      });

    case "poll_generation_status":
      return pollGenerationStatus({
        generatedLivedocId: String(args.generatedLivedocId!),
      });

    case "download_generated_file":
      return downloadGeneratedFile({
        generatedLivedocId: String(args.generatedLivedocId!),
        outputId: String(args.outputId!),
      });

    case "open_form_ui":
      return openFormUi({
        teamSiteId: String(args.teamSiteId!),
        versionId: String(args.versionId!),
        context: args.context ? String(args.context) : undefined,
        prefillValues: (args.prefillValues as Record<string, unknown>) ?? undefined,
      });

    case "get_form_result":
      return getGenerationResult(String(args.token ?? ""));

    default:
      throw new Error(`Unknown MCP tool: ${toolName}`);
  }
}
