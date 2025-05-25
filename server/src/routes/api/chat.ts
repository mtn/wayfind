import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const debug = process.env.DEBUG_CHAT === "true";

import { Router, Request, Response } from "express";
import { anthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import {
  setBreakpointByLine,
  setBreakpointBySearch,
  launchDebug,
  continueExecution,
  evaluateExpression,
  readFileContent,
  generateToolDocs,
} from "@/tools/dapTools";

// Regex pattern to find text chunks in the format: digit:"text"
const PART_RE = /(?:^|\n)\d+:"((?:[^"\\]|\\.)*)"/g;

/**
 * Normalizes the input buffer
 * @param buf The input buffer string
 * @returns Normalized string
 */
function normalise(buf: string): string {
  buf = buf.trim();
  // If it's a valid JSON string (starts/ends with quote) try to unescape it
  if (buf.startsWith('"') && buf.endsWith('"')) {
    try {
      return JSON.parse(buf);
    } catch (error) {
      // If JSON parsing fails, continue to the next step
    }
  }
  // Otherwise convert literal "\n", "\t", "\\" sequences
  return buf.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
}

/**
 * Decodes the stream-encoded text
 * @param stream The stream-encoded text
 * @returns Decoded text
 */
function decode(stream: string): string {
  let match;
  const textParts: string[] = [];

  // Find all matches of the pattern and extract the text parts
  while ((match = PART_RE.exec(stream)) !== null) {
    if (match[1]) {
      // JSON-unescape each chunk (handles \" and \\n inside)
      try {
        const unescaped = JSON.parse(`"${match[1]}"`);
        textParts.push(unescaped);
      } catch (error) {
        // If parsing fails, add the raw text
        textParts.push(match[1]);
      }
    }
  }

  // Join all text parts
  return textParts.join("");
}

/**
 * Extracts metadata from the stream
 * @param stream The stream-encoded text
 * @returns Object containing metadata
 */
function extractMetadata(stream: string): any {
  const metadata: any = {};

  // Extract message ID
  const messageIdMatch = stream.match(/f:\{"messageId":"([^"]+)"\}/);
  if (messageIdMatch && messageIdMatch[1]) {
    metadata.messageId = messageIdMatch[1];
  }

  // Extract finish reason and usage info
  const finishMatch = stream.match(/e:\{([^}]+)\}/);
  if (finishMatch && finishMatch[1]) {
    try {
      const finishData = JSON.parse(`{${finishMatch[1]}}`);
      metadata.finish = finishData;
    } catch (error) {
      // If parsing fails, ignore
    }
  }

  return metadata;
}

const router = Router();

interface ToolCall {
  toolName: string;
  timestamp: number;
}

type DebugTools = {
  setBreakpointByLine: typeof setBreakpointByLine;
  setBreakpointBySearch: typeof setBreakpointBySearch;
  readFileContent: typeof readFileContent;
  launchDebug?: typeof launchDebug;
  continueExecution?: typeof continueExecution;
  evaluateExpression?: typeof evaluateExpression;
};

interface DebugLogEntry {
  direction: "request" | "response" | "response-chunk";
  timestamp: number;
  payload: any;
  conversationId?: string;
}
const debugStore: DebugLogEntry[] = [];

function getToolsForDebugStatus(debugStatus: string): DebugTools {
  const baseTools = {
    setBreakpointByLine,
    setBreakpointBySearch,
    readFileContent,
  };
  switch (debugStatus) {
    case "notstarted":
    case "terminated":
      return { ...baseTools, launchDebug };
    case "paused":
      return {
        ...baseTools,
        continueExecution,
        evaluateExpression,
      };
    case "running":
      return baseTools;
    default:
      return baseTools;
  }
}

router.post("/", async (req: Request, res: Response) => {
  // log the raw request
  debugStore.push({
    direction: "request",
    timestamp: Date.now(),
    payload: req.body,
  });

  console.log("Hit the endpoint");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }
  try {
    const { messages, debugState } = req.body;
    if (!messages) {
      res.status(400).json({ error: "Missing messages in request body" });
      return;
    }

    if (debug) {
      console.log("Incoming messages:", JSON.stringify(messages, null, 2));
    }

    const debugStatus = debugState?.debugStatus ?? "notstarted";
    const debugLanguage = debugState?.debugLanguage ?? "unknown";
    const toolCallLog = debugState?.toolCallLog ?? [];
    const wasLaunchDebugRecentlyCalled = toolCallLog.some(
      (call: ToolCall) =>
        call.toolName === "launchDebug" && Date.now() - call.timestamp < 5000,
    ); // within last 5 seconds

    const tools = getToolsForDebugStatus(debugStatus);
    console.log("TOOLS AVAILABLE", Object.keys(tools));

    if (wasLaunchDebugRecentlyCalled && "launchDebug" in tools) {
      delete tools.launchDebug;
    }

    const executionFile = debugState?.executionFile;
    const executionLine = debugState?.executionLine;
    let locationInfo = "";
    if (debugStatus === "paused" && executionFile && executionLine) {
      locationInfo = `Execution is currently paused at line ${executionLine} in file ${executionFile}.`;
    }

    const toolDocs = generateToolDocs(tools);
    const systemPrompt = {
      role: "system",
      content: `You are a highly skilled debugging assistant specializing in ${debugLanguage} development.
              When you're asked questions about the code, you should always first consider using the debugging tools available to you
              to answer it efficiently and accurately. ${toolDocs}

              Current debug status: ${debugStatus}
              Programming language: ${debugLanguage}
              ${locationInfo}

              IMPORTANT: Always ask for confirmation from the user before launching the program, unless they explicitly requested it in their messages.

              IMPORTANT: For setting breakpoints, prefer using setBreakpointBySearch instead of setBreakpointByLine
              whenever possible. This allows you to set breakpoints by searching for code content rather than
              relying on specific line numbers, which is more reliable if the code has been modified.

              IMPORTANT: If you are sent a file as an attachment, then there's no need to read it in using the readFileContent tool. However, it may be useful to read in a section of it (e.g. to get an idea of where in the code we are when stopped at a breakpoint).

              Keep in mind that to read or trace the value of a variable, you need to set a breakpoint at least one line _after_ the line that it is
              defined on, otherwise, it'll come back as undefined.
              If you're asked to evaluate how a variable changes as the program runs, set a breakpoint by searching for the variable definition / update and set the breakpoint with offset 1 from that line to get the line after, and then ONLY evaluate the variable in each loop iteration.
              After you've set up the breakpoints, don't forget to launch the program, and also don't forget to continue execution when paused
              (if it makes sense to do so).

              If you can't complete the task in the available number of steps, that's alright, just start it and then you'll be given more steps to finish.
              Whenever you provide a summary of what you've found, be concise and clear, focusing on the most important details.`,
    };

    const result = streamText({
      model: anthropic("claude-3-7-sonnet-20250219"),
      messages: [systemPrompt, ...messages],
      tools,
      maxSteps: 1,
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 2048 },
        },
      },
      onChunk: (chunk) => {
        if (debug) {
          if (chunk.chunk.type === "reasoning") {
            console.log("Received reasoning chunk:", chunk);
          } else if (chunk.chunk.type === "text-delta") {
            console.log("Received text-delta chunk:", chunk.chunk.textDelta);
          } else {
            console.log("Received other chunk type:", chunk.chunk.type);
          }
        }
      },
    });

    // Stream the result.
    if (typeof (result as any).pipe === "function") {
      const conversationId = Date.now().toString();
      const responseBuffer: string[] = [];

      if (typeof (result as any).on === "function") {
        (result as any).on("data", (chunk: Buffer) => {
          const chunkStr = chunk.toString();
          responseBuffer.push(chunkStr);

          // Store individual chunks for detailed debugging if needed
          if (debug) {
            // Create an enhanced payload with both raw and decoded content
            const enhancedPayload = {
              raw: chunkStr,
              decoded: chunkStr.includes('":"') ? decode(chunkStr) : chunkStr,
              metadata: extractMetadata(chunkStr),
            };

            debugStore.push({
              direction: "response-chunk",
              timestamp: Date.now(),
              payload: enhancedPayload,
              conversationId,
            });
          }
        });

        // Store the complete response when streaming ends
        (result as any).on("end", () => {
          const completeResponse = responseBuffer.join("");
          const enhancedPayload = {
            raw: completeResponse,
            decoded: decode(normalise(completeResponse)),
            metadata: extractMetadata(completeResponse),
          };

          debugStore.push({
            direction: "response",
            timestamp: Date.now(),
            payload: enhancedPayload,
            conversationId,
          });
        });
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      (result as any).pipe(res);
    } else if (typeof (result as any).toDataStreamResponse === "function") {
      const response = (result as any).toDataStreamResponse({
        sendReasoning: true,
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      const conversationId = Date.now().toString();
      const responseBuffer: string[] = [];

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      async function read() {
        if (!reader) return;
        const { done, value } = await reader.read();

        if (done) {
          // Store the complete response when streaming ends
          const completeResponse = responseBuffer.join("");
          const enhancedPayload = {
            raw: completeResponse,
            decoded: decode(normalise(completeResponse)),
            metadata: extractMetadata(completeResponse),
          };

          debugStore.push({
            direction: "response",
            timestamp: Date.now(),
            payload: enhancedPayload,
            conversationId,
          });
          res.end();
          return;
        }

        const decoded = decoder.decode(value);
        responseBuffer.push(decoded);

        // Store individual chunks for detailed debugging
        if (debug) {
          // Create an enhanced payload with both raw and decoded content
          const enhancedPayload = {
            raw: decoded,
            decoded: decoded.includes('":"') ? decode(decoded) : decoded,
            metadata: extractMetadata(decoded),
          };

          debugStore.push({
            direction: "response-chunk",
            timestamp: Date.now(),
            payload: enhancedPayload,
            conversationId,
          });
        }

        res.write(decoded);
        read();
      }
      read();
    } else {
      const text = result;
      res.status(200).send(text);
    }
  } catch (error: any) {
    console.error("Error processing chat request:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

// return raw JSON:
router.get("/logs", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(debugStore, null, 2));
});

// HTML template for the logs viewer
const logsViewerTemplate = `
<!DOCTYPE html>
<html>
<head>
  <title>LLM Debug Logs</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    .decoded {
      margin-bottom: 15px;
      background-color: #f5fff5;
      border: 1px solid #d0f0d0;
      border-radius: 4px;
      padding: 10px;
    }
    .metadata {
      margin-bottom: 15px;
      background-color: #fffff0;
      border: 1px solid #f0e0c0;
      border-radius: 4px;
      padding: 10px;
    }
    .raw {
      margin-bottom: 15px;
      background-color: #f5f5f5;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 10px;
    }
    .container {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .conversation-group {
      border: 1px solid #ddd;
      border-radius: 8px;
      overflow: hidden;
    }
    .log-entry {
      padding: 15px;
      background-color: #f9f9f9;
      border-bottom: 1px solid #eee;
    }
    .log-entry:last-child {
      border-bottom: none;
    }
    .request-entry {
      background-color: #f0f7ff;
    }
    .response-entry {
      background-color: #f9f9f9;
      margin-left: 20px;
    }
    .response-chunk-entry {
      background-color: #f5f5f5;
      margin-left: 30px;
      border-left: 3px solid #ddd;
    }
    .log-info {
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px solid #eee;
      font-size: 14px;
    }
    .log-direction {
      font-weight: bold;
    }
    .request {
      color: #0066cc;
    }
    .response {
      color: #009933;
    }
    .navigation {
      display: flex;
      gap: 10px;
      margin: 20px 0;
      align-items: center;
    }
    button {
      padding: 8px 16px;
      background: #f0f0f0;
      border: 1px solid #ddd;
      border-radius: 4px;
      cursor: pointer;
    }
    button:hover {
      background: #e0e0e0;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    pre {
      white-space: pre-wrap;
      overflow-x: auto;
      background-color: #f5f5f5;
      padding: 10px;
      border-radius: 4px;
      margin: 0;
    }
    .pagination-info {
      text-align: center;
      margin: 0 auto;
      font-size: 14px;
    }
    .timestamp {
      color: #666;
      font-size: 12px;
    }
    h2 {
      margin-top: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .search-box {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      align-items: center;
    }
    .search-box input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    .search-results {
      margin-top: 20px;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 15px;
      display: none;
    }
    .search-results h3 {
      margin-top: 0;
      margin-bottom: 10px;
    }
    .result-list {
      list-style-type: none;
      padding: 0;
      margin: 0;
    }
    .result-list li {
      margin-bottom: 8px;
      border-bottom: 1px solid #eee;
      padding-bottom: 8px;
    }
    .result-list li:last-child {
      border-bottom: none;
      margin-bottom: 0;
    }
    .result-link {
      color: #0066cc;
      text-decoration: none;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .result-link:hover {
      text-decoration: underline;
    }
    .match-info {
      color: #666;
      font-size: 12px;
    }
    .highlight {
      background-color: #ffff00;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <h1>Chat ↔️ LLM Logs</h1>
  <div class="container">
    <!-- Search box -->
    <div class="search-box">
      <input type="text" id="search-input" placeholder="Search logs for keywords..." />
      <button id="search-btn">Search</button>
    </div>

    <!-- Search results container, initially hidden -->
    <div id="search-results" class="search-results">
      <h3>Search Results</h3>
      <ul id="result-list" class="result-list">
        <!-- Results will be added here -->
      </ul>
    </div>

    <div class="navigation">
      <button id="first-btn" disabled>First</button>
      <button id="prev-btn" disabled>Previous</button>
      <div class="pagination-info">Conversation <span id="current-index">0</span> of <span id="total-entries">0</span></div>
      <button id="next-btn" disabled>Next</button>
      <button id="last-btn" disabled>Last</button>
    </div>
    <div id="conversation-container">
      <!-- Conversation groups will be inserted here -->
    </div>
  </div>

  <script>
    let rawLogs = [];
    let conversationGroups = [];
    let currentGroupIndex = 0;

    // Format timestamp to readable date
    function formatTimestamp(timestamp) {
      return new Date(timestamp).toLocaleString();
    }

    // Group logs into request-response conversations
    function groupLogs(logs) {
      const groups = [];
      let currentGroup = null;

      for (const log of logs) {
        if (log.direction === 'request') {
          // Start a new group when we see a request
          if (currentGroup) {
            groups.push(currentGroup);
          }
          currentGroup = {
            request: log,
            responses: [],
            chunks: []
          };
        } else if (log.direction === 'response' && currentGroup) {
          // Add complete response to current group
          currentGroup.responses.push(log);
        } else if (log.direction === 'response-chunk' && currentGroup) {
          // Store chunks for debugging if needed
          currentGroup.chunks.push(log);
        }
      }

      // Add the last group if it exists
      if (currentGroup) {
        groups.push(currentGroup);
      }

      return groups;
    }

    // Create HTML for a single log entry
    function createLogEntryHTML(log, isRequest) {
      let className;
      if (isRequest) {
        className = 'log-entry request-entry';
      } else if (log.direction === 'response-chunk') {
        className = 'log-entry response-chunk-entry';
      } else {
        className = 'log-entry response-entry';
      }

      const directionClass = isRequest ? 'request' : 'response';

      // Handle both old format (direct payload) and new format (enhanced payload)
      let payloadContent = '';

      // Check if payload has the enhanced structure
      if (log.payload && (log.payload.raw !== undefined || log.payload.decoded !== undefined)) {
        // Display metadata if available
        if (log.payload.metadata && Object.keys(log.payload.metadata).length > 0) {
          const metadataStr = JSON.stringify(log.payload.metadata, null, 2)
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          payloadContent += \`<div class="metadata"><h4>Metadata</h4><pre>\${metadataStr}</pre></div>\`;
        }

        // Display decoded content if available
        if (log.payload.decoded && log.payload.decoded.trim()) {
          payloadContent += \`<div class="decoded"><h4>Decoded Content</h4><pre>\${log.payload.decoded}</pre></div>\`;
        }

        // Always include raw content
        const rawStr = JSON.stringify(log.payload.raw, null, 2)
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        payloadContent += \`<div class="raw"><h4>Raw Content</h4><pre>\${rawStr}</pre></div>\`;
      } else {
        // Handle original format (backwards compatibility)
        const formattedPayload = JSON.stringify(log.payload, null, 2)
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        payloadContent = \`<pre>\${formattedPayload}</pre>\`;
      }

      return \`
        <div class="\${className}">
          <div class="log-info">
            <span class="log-direction \${directionClass}">\${log.direction.toUpperCase()}</span>
            <span class="timestamp">\${formatTimestamp(log.timestamp)}</span>
          </div>
          \${payloadContent}
        </div>
      \`;
    }

    // Update UI to show current conversation group
    function showCurrentGroup() {
      const container = document.getElementById('conversation-container');

      if (conversationGroups.length === 0) {
        container.innerHTML = '<div class="conversation-group"><div class="log-entry">No logs available</div></div>';
        return;
      }

      const group = conversationGroups[currentGroupIndex];
      let html = '<div class="conversation-group">';

      // Add request
      html += createLogEntryHTML(group.request, true);

      // Add complete responses
      if (group.responses && group.responses.length > 0) {
        for (const response of group.responses) {
          html += createLogEntryHTML(response, false);
        }
      }
      // For backward compatibility - if no complete responses, show chunks
      else if (group.chunks && group.chunks.length > 0 && (!group.responses || group.responses.length === 0)) {
        // Option to show each chunk individually or concatenate them
        const showIndividualChunks = false; // Set to true to see individual chunks

        if (showIndividualChunks) {
          for (const chunk of group.chunks) {
            html += createLogEntryHTML(chunk, false);
          }
        } else {
          // Create a single entry with all chunks concatenated
          const concatenatedEntry = {
            direction: 'response',
            timestamp: group.chunks[0].timestamp,
            payload: group.chunks.map(chunk => chunk.payload).join('')
          };
          html += createLogEntryHTML(concatenatedEntry, false);
        }
      }

      html += '</div>';
      container.innerHTML = html;

      // Update pagination info
      document.getElementById('current-index').textContent = currentGroupIndex + 1;
      document.getElementById('total-entries').textContent = conversationGroups.length;

      // Update button states
      document.getElementById('first-btn').disabled = currentGroupIndex === 0;
      document.getElementById('prev-btn').disabled = currentGroupIndex === 0;
      document.getElementById('next-btn').disabled = currentGroupIndex === conversationGroups.length - 1;
      document.getElementById('last-btn').disabled = currentGroupIndex === conversationGroups.length - 1;
    }

    // Fetch logs and update UI
    async function fetchLogs() {
      try {
        const response = await fetch('/api/chat/logs');
        rawLogs = await response.json();

        // Sort logs by timestamp (oldest first)
        rawLogs.sort((a, b) => a.timestamp - b.timestamp);

        // Group logs into conversations
        conversationGroups = groupLogs(rawLogs);

        // Update UI
        showCurrentGroup();
      } catch (error) {
        console.error('Error fetching logs:', error);
      }
    }

    // Initialize and set up event listeners
    function initialize() {
      // Fetch initial logs
      fetchLogs();

      // Set up navigation buttons
      document.getElementById('first-btn').addEventListener('click', () => {
        currentGroupIndex = 0;
        showCurrentGroup();
      });

      document.getElementById('prev-btn').addEventListener('click', () => {
        if (currentGroupIndex > 0) {
          currentGroupIndex--;
          showCurrentGroup();
        }
      });

      document.getElementById('next-btn').addEventListener('click', () => {
        if (currentGroupIndex < conversationGroups.length - 1) {
          currentGroupIndex++;
          showCurrentGroup();
        }
      });

      document.getElementById('last-btn').addEventListener('click', () => {
        currentGroupIndex = conversationGroups.length - 1;
        showCurrentGroup();
      });

      // Refresh logs periodically
      setInterval(fetchLogs, 5000);
    }

    // Start the app
    initialize();

    // Search functionality
    function searchLogs(query) {
      if (!query || query.trim() === '') return [];

      query = query.toLowerCase().trim();
      const results = [];

      // Search through all conversations
      conversationGroups.forEach((group, index) => {
        let matchesInRequest = 0;
        let matchesInResponses = 0;
        let matchesInDecoded = 0;

        // Check request payload
        const requestStr = JSON.stringify(group.request.payload).toLowerCase();
        if (requestStr.includes(query)) {
          matchesInRequest = (requestStr.match(new RegExp(query, 'gi')) || []).length;
        }

        // Check complete responses first
        group.responses.forEach(response => {
          // Check in raw payload
          const responseStr = JSON.stringify(response.payload).toLowerCase();
          if (responseStr.includes(query)) {
            matchesInResponses += (responseStr.match(new RegExp(query, 'gi')) || []).length;
          }

          // Also check in decoded content if available (enhanced format)
          if (response.payload && response.payload.decoded) {
            const decodedStr = response.payload.decoded.toLowerCase();
            if (decodedStr.includes(query)) {
              matchesInDecoded += (decodedStr.match(new RegExp(query, 'gi')) || []).length;
            }
          }
        });

        // If no matches in complete responses, try concatenating chunks
        // This is needed for backwards compatibility with old log entries
        if (matchesInResponses === 0 && matchesInDecoded === 0 && group.chunks && group.chunks.length > 0) {
          const concatenatedChunks = group.chunks
            .map(chunk => JSON.stringify(chunk.payload))
            .join("").toLowerCase();

          if (concatenatedChunks.includes(query)) {
            matchesInResponses += (concatenatedChunks.match(new RegExp(query, 'gi')) || []).length;
          }

          // Check in decoded content for chunks (enhanced format)
          const decodedChunks = group.chunks
            .filter(chunk => chunk.payload && chunk.payload.decoded)
            .map(chunk => chunk.payload.decoded)
            .join("").toLowerCase();

          if (decodedChunks && decodedChunks.includes(query)) {
            matchesInDecoded += (decodedChunks.match(new RegExp(query, 'gi')) || []).length;
          }
        }

        // If there are matches, add to results
        if (matchesInRequest > 0 || matchesInResponses > 0 || matchesInDecoded > 0) {
          const timestamp = formatTimestamp(group.request.timestamp);
          results.push({
            index,
            timestamp,
            matchesInRequest,
            matchesInResponses,
            matchesInDecoded,
            totalMatches: matchesInRequest + matchesInResponses + matchesInDecoded
          });
        }
      });

      return results;
    }

    function displaySearchResults(results) {
      const resultsContainer = document.getElementById('search-results');
      const resultsList = document.getElementById('result-list');

      // Clear previous results
      resultsList.innerHTML = '';

      if (results.length === 0) {
        resultsList.innerHTML = '<li>No matches found</li>';
        resultsContainer.style.display = 'block';
        return;
      }

      // Sort results by total matches in descending order
      results.sort((a, b) => b.totalMatches - a.totalMatches);

      // Create result items
      results.forEach(result => {
        const li = document.createElement('li');
        const requestMatches = result.matchesInRequest > 0 ?
          '<span class="match-info">' + result.matchesInRequest + ' in request</span>' : '';
        const responseMatches = result.matchesInResponses > 0 ?
          '<span class="match-info">' + result.matchesInResponses + ' in raw responses</span>' : '';
        const decodedMatches = result.matchesInDecoded > 0 ?
          '<span class="match-info">' + result.matchesInDecoded + ' in decoded text</span>' : '';

        li.innerHTML =
          '<a class="result-link" data-index="' + result.index + '">' +
            '<span>Conversation #' + (result.index + 1) + ' (' + result.timestamp + ')</span>' +
            '<span>' +
              [requestMatches, responseMatches, decodedMatches].filter(Boolean).join(' | ') +
            '</span>' +
          '</a>';

        resultsList.appendChild(li);
      });

      // Add click events to links
      document.querySelectorAll('.result-link').forEach(link => {
        link.addEventListener('click', function() {
          const index = parseInt(this.getAttribute('data-index'), 10);
          currentGroupIndex = index;
          showCurrentGroup();
          resultsContainer.style.display = 'none'; // Hide results after clicking
        });
      });

      // Show results container
      resultsContainer.style.display = 'block';
    }

    // Set up search button
    document.getElementById('search-btn').addEventListener('click', function() {
      const query = document.getElementById('search-input').value;
      const results = searchLogs(query);
      displaySearchResults(results);
    });

    // Enable search on Enter key
    document.getElementById('search-input').addEventListener('keyup', function(event) {
      if (event.key === 'Enter') {
        document.getElementById('search-btn').click();
      }
    });
  </script>
</body>
</html>
`;

// an HTML viewer for grouped request/response logs
router.get("/view-logs", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(logsViewerTemplate);
});

export default router;
