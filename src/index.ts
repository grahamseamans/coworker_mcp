import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { homedir } from "os";
import { join, basename, extname } from "path";

const XAI_API_KEY = process.env.XAI_API_KEY;

if (!XAI_API_KEY) {
  console.error("XAI_API_KEY environment variable is required");
  process.exit(1);
}

// Fetch available models from X API
async function fetchAvailableModels(): Promise<string[]> {
  const response = await fetch("https://api.x.ai/v1/models", {
    headers: {
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`X API error fetching models: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as { data: Array<{ id: string }> };
  return data.data.map((m) => m.id);
}

// Storage path
const CONVERSATIONS_FILE = join(homedir(), ".grok-conversations.json");

// Types
interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Conversation {
  id: string;
  name: string;
  project?: string;
  temp?: boolean;
  messages: Message[];
  createdAt: string;
  lastActive: string;
}

interface ConversationsStore {
  conversations: Conversation[];
}

// Load/save functions
function loadConversations(): ConversationsStore {
  if (!existsSync(CONVERSATIONS_FILE)) {
    return { conversations: [] };
  }
  const data = readFileSync(CONVERSATIONS_FILE, "utf-8");
  return JSON.parse(data) as ConversationsStore;
}

function saveConversations(store: ConversationsStore): void {
  writeFileSync(CONVERSATIONS_FILE, JSON.stringify(store, null, 2));
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

const MAX_STORAGE_BYTES = 1024 * 1024 * 1024; // 1GB

function tempConversationsSize(store: ConversationsStore): number {
  const temps = store.conversations.filter((c) => c.temp);
  return Buffer.byteLength(JSON.stringify(temps));
}

function cleanupTempConversations(store: ConversationsStore): boolean {
  if (tempConversationsSize(store) <= MAX_STORAGE_BYTES) return false;

  const temps = store.conversations
    .filter((c) => c.temp)
    .sort((a, b) => new Date(a.lastActive).getTime() - new Date(b.lastActive).getTime());

  let removed = 0;
  for (const temp of temps) {
    const idx = store.conversations.indexOf(temp);
    store.conversations.splice(idx, 1);
    removed++;
    if (tempConversationsSize(store) <= MAX_STORAGE_BYTES) break;
  }

  if (removed > 0) {
    saveConversations(store);
    return true;
  }
  return false;
}

function readFileContent(filePath: string): { name: string; content: string } | { name: string; error: string } {
  const name = basename(filePath);
  if (!existsSync(filePath)) {
    return { name, error: `File not found: ${filePath}` };
  }
  const content = readFileSync(filePath, "utf-8");
  return { name, content };
}

function formatFilesForMessage(files: string[]): string {
  if (!files || files.length === 0) return "";

  const formatted = files.map((filePath) => {
    const result = readFileContent(filePath);
    if ("error" in result) {
      return `\n--- File: ${result.name} ---\n[Error: ${result.error}]\n--- End file ---`;
    }
    const ext = extname(filePath).slice(1) || "txt";
    return `\n--- File: ${result.name} ---\n\`\`\`${ext}\n${result.content}\n\`\`\`\n--- End file ---`;
  });

  return "\n" + formatted.join("\n");
}

// X API (Responses format)
interface XAIResponse {
  id: string;
  model: string;
  output: Array<{
    type: string;
    content?: Array<{
      type: string;
      text?: string;
    }>;
  }>;
  citations?: string[];
}

interface SendOptions {
  model: string;
  enableWebSearch?: boolean;
  enableXSearch?: boolean;
}

async function sendToXAI(
  messages: Message[],
  options: SendOptions
): Promise<{ text: string; model: string; citations?: string[] }> {
  // Build tools array based on options
  const tools: Array<{ type: string }> = [];
  if (options.enableWebSearch !== false) {
    tools.push({ type: "web_search" });
  }
  if (options.enableXSearch) {
    tools.push({ type: "x_search" });
  }

  const response = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: options.model,
      input: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      ...(tools.length > 0 && { tools }),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`X API error: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as XAIResponse;

  // Extract text from output array (content is nested array with text objects)
  const textContent = data.output
    .filter((o) => o.type === "message" && o.content)
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === "output_text" && c.text)
    .map((c) => c.text)
    .join("\n") || "No response generated";

  return {
    text: textContent,
    model: data.model,
    citations: data.citations,
  };
}

// Server setup
const server = new Server(
  {
    name: "coworker",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "coworker_list_models",
        description:
          "List available Grok models from the X API. If unsure which model to use for a task, pick the most advanced model from this list and ask it which model is best for your specific use case.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "coworker_find_conversations",
        description:
          "Search for relevant conversations within a project using semantic matching via Grok. Returns only conversations relevant to your query.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "What you're looking for (e.g., 'audio system design', 'shadow mapping bugs')",
            },
            project: {
              type: "string",
              description: "The project to search within. Use coworker_list_projects to see available projects.",
            },
          },
          required: ["query", "project"],
        },
      },
      {
        name: "coworker_list_projects",
        description:
          "List all projects that have conversations. Returns project names and conversation counts.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "coworker_new_conversation",
        description:
          "Start a new Coworker conversation thread. Must specify either a project (persistent, searchable) or temp: true (disposable, not searchable). Returns the conversation id.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "A descriptive name for the conversation (e.g., 'shader-rendering-help', 'api-design-questions')",
            },
            project: {
              type: "string",
              description:
                "Project to associate with. Makes the conversation persistent and searchable via coworker_find_conversations.",
            },
            temp: {
              type: "boolean",
              description:
                "Set to true for disposable conversations. These are multi-turn but won't appear in search results.",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "coworker_send",
        description:
          "Send a message to an existing Coworker conversation. Use coworker_list_models to see available models. If unsure which model to use, ask the most advanced model for guidance.",
        inputSchema: {
          type: "object",
          properties: {
            conversation_id: {
              type: "string",
              description: "The conversation id to send to",
            },
            model: {
              type: "string",
              description: "The model ID to use (from coworker_list_models). If invalid, the API will return an error.",
            },
            message: {
              type: "string",
              description: "The message to send",
            },
            files: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of file paths to attach. Files will be read and included in the message.",
            },
            enable_web_search: {
              type: "boolean",
              description: "Enable web search (default: true)",
            },
            enable_x_search: {
              type: "boolean",
              description: "Enable X/Twitter search (default: false)",
            },
          },
          required: ["conversation_id", "model", "message"],
        },
      },
      {
        name: "coworker_get_history",
        description: "Get the full message history for a conversation.",
        inputSchema: {
          type: "object",
          properties: {
            conversation_id: {
              type: "string",
              description: "The conversation id",
            },
          },
          required: ["conversation_id"],
        },
      },
      {
        name: "coworker_delete_conversation",
        description: "Delete a conversation by id.",
        inputSchema: {
          type: "object",
          properties: {
            conversation_id: {
              type: "string",
              description: "The conversation id to delete",
            },
          },
          required: ["conversation_id"],
        },
      },
      {
        name: "coworker_search",
        description: "Search across all conversations for a keyword or phrase. Returns matching messages with context.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query",
            },
          },
          required: ["query"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "coworker_list_models": {
      const models = await fetchAvailableModels();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(models, null, 2),
          },
        ],
      };
    }

    case "coworker_find_conversations": {
      const { query, project } = args as { query: string; project: string };
      if (!query || !project) {
        throw new Error("query and project are required");
      }

      const store = loadConversations();
      cleanupTempConversations(store);

      const candidates = store.conversations.filter(
        (c) => c.project === project
      );

      if (candidates.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No conversations found in project "${project}". Use coworker_list_projects to see available projects.`,
            },
          ],
        };
      }

      const metadata = candidates.map((c) => {
        let preview = "";
        for (const m of c.messages) {
          if (m.role === "user") {
            preview = m.content.substring(0, 150);
            break;
          }
        }
        return {
          id: c.id,
          name: c.name,
          messages: c.messages.length,
          lastActive: c.lastActive.substring(0, 10),
          preview,
        };
      });

      const metadataJson = JSON.stringify(metadata, null, 1);

      const prompt = `You are a conversation search assistant. Given a search query and a list of conversations, return ONLY the conversations that are relevant to the query.

SEARCH QUERY: "${query}"

CONVERSATIONS:
${metadataJson}

Return a JSON array of objects: { id, name, messages, lastActive, relevance }
- relevance: a brief phrase explaining why this conversation matches
- Only genuinely matching conversations
- Max 10 results, sorted by relevance
- Return empty array [] if nothing matches
- Return ONLY the JSON array, no other text`;

      const result = await sendToXAI(
        [{ role: "user", content: prompt }],
        { model: "grok-4-1-fast-reasoning", enableWebSearch: false }
      );

      const jsonMatch = result.text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return {
          content: [
            {
              type: "text",
              text: `Search results for "${query}" in project "${project}":\n\n${result.text}`,
            },
          ],
        };
      }

      const results = JSON.parse(jsonMatch[0]);
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No conversations found matching "${query}" in project "${project}".`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }

    case "coworker_list_projects": {
      const store = loadConversations();
      const projectCounts = new Map<string, number>();

      for (const conv of store.conversations) {
        if (conv.project) {
          projectCounts.set(conv.project, (projectCounts.get(conv.project) || 0) + 1);
        }
      }

      if (projectCounts.size === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No projects found. Use the 'project' parameter in coworker_new_conversation to create conversations in a project.",
            },
          ],
        };
      }

      const projects = Array.from(projectCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ project: name, conversations: count }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    }

    case "coworker_new_conversation": {
      const { name: convName, project, temp } = args as {
        name: string;
        project?: string;
        temp?: boolean;
      };
      if (!convName) {
        throw new Error("name is required");
      }
      if (project && temp) {
        throw new Error("Cannot set both 'project' and 'temp'. Use one or the other.");
      }
      if (!project && !temp) {
        throw new Error("Must specify either 'project' (for persistent conversations) or 'temp: true' (for disposable conversations).");
      }

      const store = loadConversations();
      cleanupTempConversations(store);

      const now = new Date().toISOString();
      const newConv: Conversation = {
        id: generateId(),
        name: convName,
        ...(project ? { project } : { temp: true }),
        messages: [],
        createdAt: now,
        lastActive: now,
      };
      store.conversations.push(newConv);
      saveConversations(store);

      const label = project ? `[project: ${project}]` : "[temp]";
      return {
        content: [
          {
            type: "text",
            text: `Created conversation "${convName}" ${label} with id: ${newConv.id}`,
          },
        ],
      };
    }

    case "coworker_send": {
      const { conversation_id, model, message, files, enable_web_search, enable_x_search } = args as {
        conversation_id: string;
        model: string;
        message: string;
        files?: string[];
        enable_web_search?: boolean;
        enable_x_search?: boolean;
      };
      if (!conversation_id || !model || !message) {
        throw new Error("conversation_id, model, and message are required");
      }

      const store = loadConversations();
      const conv = store.conversations.find((c) => c.id === conversation_id);
      if (!conv) {
        throw new Error(`Conversation not found: ${conversation_id}`);
      }

      // Build message with optional file attachments
      const fileContent = formatFilesForMessage(files || []);
      const fullMessage = message + fileContent;

      // Add user message
      conv.messages.push({ role: "user", content: fullMessage });
      conv.lastActive = new Date().toISOString();

      // Send to X API with full history
      const result = await sendToXAI(conv.messages, {
        model,
        enableWebSearch: enable_web_search,
        enableXSearch: enable_x_search,
      });

      // Add assistant response
      conv.messages.push({ role: "assistant", content: result.text });
      saveConversations(store);

      let responseText = result.text;
      if (result.citations && result.citations.length > 0) {
        responseText += `\n\n---\nCitations:\n${result.citations.join("\n")}`;
      }
      responseText += `\n\n[Model: ${result.model}]`;

      return {
        content: [
          {
            type: "text",
            text: responseText,
          },
        ],
      };
    }

    case "coworker_get_history": {
      const { conversation_id } = args as { conversation_id: string };
      if (!conversation_id) {
        throw new Error("conversation_id is required");
      }

      const store = loadConversations();
      const conv = store.conversations.find((c) => c.id === conversation_id);
      if (!conv) {
        throw new Error(`Conversation not found: ${conversation_id}`);
      }

      if (conv.messages.length === 0) {
        return {
          content: [{ type: "text", text: "(no messages yet)" }],
        };
      }

      // Format conversation and ask for summary
      const history = conv.messages
        .map((m) => `[${m.role}]: ${m.content}`)
        .join("\n\n");

      const summaryResult = await sendToXAI(
        [
          {
            role: "user",
            content: `Summarize this conversation concisely. Include key topics discussed, decisions made, and any open questions:\n\n${history}`,
          },
        ],
        { model: "grok-4-1-fast", enableWebSearch: false }
      );

      return {
        content: [
          {
            type: "text",
            text: `**Summary of "${conv.name}"** (${conv.messages.length} messages)\n\n${summaryResult.text}`,
          },
        ],
      };
    }

    case "coworker_delete_conversation": {
      const { conversation_id } = args as { conversation_id: string };
      if (!conversation_id) {
        throw new Error("conversation_id is required");
      }

      const store = loadConversations();
      const idx = store.conversations.findIndex((c) => c.id === conversation_id);
      if (idx === -1) {
        throw new Error(`Conversation not found: ${conversation_id}`);
      }

      const removed = store.conversations.splice(idx, 1)[0];
      saveConversations(store);

      return {
        content: [
          {
            type: "text",
            text: `Deleted conversation "${removed.name}" (${removed.id})`,
          },
        ],
      };
    }

    case "coworker_search": {
      const { query } = args as { query: string };
      if (!query) {
        throw new Error("query is required");
      }

      const store = loadConversations();
      const results: Array<{
        conversationId: string;
        conversationName: string;
        role: string;
        content: string;
      }> = [];

      const lowerQuery = query.toLowerCase();
      for (const conv of store.conversations) {
        for (const msg of conv.messages) {
          if (msg.content.toLowerCase().includes(lowerQuery)) {
            results.push({
              conversationId: conv.id,
              conversationName: conv.name,
              role: msg.role,
              content: msg.content.length > 200
                ? msg.content.substring(0, 200) + "..."
                : msg.content,
            });
          }
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for "${query}"` }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} matches for "${query}":\n\n${JSON.stringify(results, null, 2)}`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Coworker Chat MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
