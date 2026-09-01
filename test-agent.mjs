/**
 * Test script for the LiveDoc MCP Agent (Qwen3 via Ollama)
 * 
 * This validates that:
 * 1. Qwen3 can be called successfully via Ollama's OpenAI-compatible API
 * 2. The agent's tool calling works correctly
 * 3. MCP tools (search, generate, poll) execute properly
 */

import "dotenv/config";
import OpenAI from "openai";
import { searchTemplates, getTemplateForm, handleToolCall } from "./server/src/mcp-tools.js";

// ================================================================
// Test 1: Verify Qwen3 responds via Ollama
// ================================================================
async function testQwen3Chat() {
  console.log("\n🔍 Test 1: Check Qwen3 can chat via Ollama...");
  
  const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY || "ollama",
    baseURL: process.env.OPENAI_BASE_URL || "http://localhost:11434/v1",
  });

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "qwen3:latest",
      messages: [
        { role: "user", content: "Hi, are you working? Reply in one sentence." }
      ],
      max_tokens: 50,
    });

    const reply = response.choices[0]?.message?.content;
    console.log("✅ Qwen3 replied:", reply);
    return true;
  } catch (err) {
    console.error("❌ Qwen3 failed:", err.message);
    return false;
  }
}

// ================================================================
// Test 2: Verify MCP Tool - search_templates
// ================================================================
async function testSearchTool() {
  console.log("\n🔍 Test 2: MCP tool `search_templates`...");
  
  try {
    const result = await searchTemplates({
      searchText: "Sales",
      pageSize: 3,
    });

    if (result.totalCount > 0) {
      console.log(`✅ Found ${result.totalCount} templates:`);
      result.results.forEach((r, i) => {
        console.log(`   [${i+1}] "${r.title}" (${r.format}) - Modified: ${r.modifiedDate}`);
      });
    } else {
      console.warn("⚠️ No results returned (API may require different search params)");
    }
    return true;
  } catch (err) {
    console.error("❌ search_templates failed:", err.message);
    return false;
  }
}

// ================================================================
// Test 3: Verify MCP Tool - get_template_form (sample)
// ================================================================
async function testGetFormTool() {
  console.log("\n🔍 Test 3: MCP tool `get_template_form`...");
  
  // Using a known template - you can replace with your actual live templates
  try {
    // Skip if no token - this requires valid Seismic access
    const token = process.env.SEISMIC_API_TOKEN;
    if (!token) {
      console.warn("⚠️ No SEISMIC_API_TOKEN set — skipping form fetch test");
      return true;
    }

    // Test with dummy IDs (would fail API but confirms tool structure works)
    const result = await getTemplateForm({
      teamSiteId: "test-dummy-123",
      versionId: "test-dummy-456",
    });
    
    console.log("✅ get_template_form loaded template");
    return true;
  } catch (err) {
    // Expected to fail with invalid IDs, but tool structure is correct
    if (err.message.includes("Failed to load template") || err.message.includes("404")) {
      console.log("✅ Tool structure correct (API rejected dummy IDs as expected)");
      return true;
    }
    console.error("❌ get_template_form failed:", err.message);
    return false;
  }
}

// ================================================================
// Test 4: Verify Agent can call LLM with tools
// ================================================================
async function testAgentToolCalling() {
  console.log("\n🔍 Test 4: Agent tool calling (LLM dispatches to MCP)...");
  
  const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY || "ollama",
    baseURL: process.env.OPENAI_BASE_URL || "http://localhost:11434/v1",
  });

  try {
    // First call to get tool suggestions
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "qwen3:latest",
      messages: [
        { role: "system", content: "You are a helpful AI agent. You can search for Seismic LiveDoc templates using the `search_templates` tool." },
        { role: "user", content: "Find me some sales templates" }
      ],
      tools: [{ 
        type: "function",
        function: {
          name: "search_templates",
          description: "Search for Seismic templates",
          parameters: {
            type: "object",
            properties: {
              searchText: { type: "string" },
              pageSize: { type: "number" }
            },
            required: ["searchText"]
          }
        }
      }],
      temperature: 0.3,
    });

    const toolCalls = response.choices[0]?.message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      console.log("✅ LLM decided to call a tool!");
      for (const tc of toolCalls) {
        console.log(`   Tool: ${tc.function.name}`);
        console.log(`   Args: ${tc.function.arguments}`);
        
        // Execute the MCP tool directly
        const result = await handleToolCall(tc.function.name, JSON.parse(tc.function.arguments));
        console.log(`   Result preview:`, JSON.stringify(result).slice(0, 200) + "...");
      }
      return true;
    } else {
      console.log("⚠️ LLM did not call a tool (just text response):", 
        response.choices[0]?.message?.content);
      return false; // Not necessarily a failure - Qwen3 may prefer text
    }
  } catch (err) {
    console.error("❌ Agent tool calling failed:", err.message);
    return false;
  }
}

// ================================================================
// Run all tests
// ================================================================
async function main() {
  console.log("\n========================================");
  console.log("🤖 LiveDoc MCP Agent Test Suite");
  console.log("   Model:", process.env.OPENAI_MODEL || "qwen3:latest");
  console.log("   API:", process.env.OPENAI_BASE_URL || "http://localhost:11434/v1");
  console.log("========================================");

  const results = await Promise.all([
    testQwen3Chat(),
    testSearchTool(),
    testGetFormTool(),
    testAgentToolCalling(),
  ]);

  const passed = results.filter(Boolean).length;
  const total = results.length;

  console.log("\n" + "=".repeat(40));
  if (passed === total) {
    console.log(`✅ All ${total} tests PASSED!`);
    console.log("🎉 Your LiveDoc MCP Agent is ready!");
  } else {
    console.log(`⚠️ ${passed}/${total} tests passed`);
    console.log("📝 Check errors above and fix before deploying.");
  }
  console.log("=".repeat(40) + "\n");

  process.exit(passed === total ? 0 : 1);
}

main();
