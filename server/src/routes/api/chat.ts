import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const debug = process.env.DEBUG_CHAT === "true";

import { Router, Request, Response } from "express";
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import {
  setBreakpoint,
  launchDebug,
  continueExecution,
  evaluateExpression,
} from "@/tools/dapTools";

const router = Router();

interface ToolCall {
  toolName: string;
  timestamp: number;
}

type DebugTools = {
  setBreakpoint: typeof setBreakpoint;
  launchDebug?: typeof launchDebug;
  continueExecution?: typeof continueExecution;
  evaluateExpression?: typeof evaluateExpression;
};

interface DebugLogEntry {
  direction: "request" | "response";
  timestamp: number;
  payload: any;
}
const debugStore: DebugLogEntry[] = [];

const toolDescriptions: Record<string, string> = {
  setBreakpoint: setBreakpoint.description ?? "",
  launchDebug: launchDebug.description ?? "",
  continueExecution: continueExecution.description ?? "",
  evaluateExpression: evaluateExpression.description ?? "",
};

function getToolsForDebugStatus(debugStatus: string): DebugTools {
  const baseTools = { setBreakpoint };
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

    const systemPrompt = {
      role: "system",
      content: `You are a highly skilled debugging assistant.
            When you're asked questions about the code, you should always first consider using the debugging tools available to you
            to answer it efficiently and accurately. You have access to the following tools:
            ${Object.keys(tools)
              .map((tool) => `- ${tool}: ${toolDescriptions[tool]}`)
              .join("\n            ")}

            Current debug status: ${debugStatus}

            Keep in mind that to read the value of a variable, you need to set a breakpoint at least one line _after_ the line that it is
            defined on, otherwise, it'll come back as undefined.
            For example, if the user asks you how the value of a variable changes as the program runs,
            you should use your tools to set breakpoint(s) at lines that let you read the value, launch the program, continue till
            it stops, evaluate the variable, and so on until it terminates.

            If you can't complete the task in the available number of steps, that's alright, just start it and then you'll be given more
            steps to finish.`,
    };

    const result = streamText({
      model: openai("gpt-4o-mini"),
      messages: [systemPrompt, ...messages],
      tools,
      maxSteps: 1,
    });

    // Stream the result.
    if (typeof (result as any).pipe === "function") {
      if (debug && typeof (result as any).on === "function") {
        (result as any).on("data", (chunk: Buffer) => {
          const chunkStr = chunk.toString();
          debugStore.push({
            direction: "response",
            timestamp: Date.now(),
            payload: chunkStr,
          });
          console.log("Stream chunk:", chunkStr);
          if (chunkStr.includes('"toolName"')) {
            console.log("Tool call chunk detected:", chunkStr);
          }
        });
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      (result as any).pipe(res);
    } else if (typeof (result as any).toDataStreamResponse === "function") {
      const response = (result as any).toDataStreamResponse();
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      async function read() {
        if (!reader) return;
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return;
        }
        const decoded = decoder.decode(value);
        debugStore.push({
          direction: "response",
          timestamp: Date.now(),
          payload: decoded,
        });
        if (debug) {
          console.log("Stream chunk:", decoded);
          if (decoded.includes('"toolName"')) {
            console.log("Tool call chunk detected:", decoded);
          }
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
            responses: []
          };
        } else if (log.direction === 'response' && currentGroup) {
          // Add response to current group
          currentGroup.responses.push(log);
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
      const className = isRequest ? 'log-entry request-entry' : 'log-entry response-entry';
      const directionClass = isRequest ? 'request' : 'response';
      const formattedPayload = JSON.stringify(log.payload, null, 2)
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      
      return \`
        <div class="\${className}">
          <div class="log-info">
            <span class="log-direction \${directionClass}">\${log.direction.toUpperCase()}</span>
            <span class="timestamp">\${formatTimestamp(log.timestamp)}</span>
          </div>
          <pre>\${formattedPayload}</pre>
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
      
      // Add responses
      for (const response of group.responses) {
        html += createLogEntryHTML(response, false);
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
        
        // Check request payload
        const requestStr = JSON.stringify(group.request.payload).toLowerCase();
        if (requestStr.includes(query)) {
          matchesInRequest = (requestStr.match(new RegExp(query, 'gi')) || []).length;
        }
        
        // Check all responses
        group.responses.forEach(response => {
          const responseStr = JSON.stringify(response.payload).toLowerCase();
          if (responseStr.includes(query)) {
            matchesInResponses += (responseStr.match(new RegExp(query, 'gi')) || []).length;
          }
        });
        
        // If there are matches, add to results
        if (matchesInRequest > 0 || matchesInResponses > 0) {
          const timestamp = formatTimestamp(group.request.timestamp);
          results.push({
            index,
            timestamp,
            matchesInRequest,
            matchesInResponses,
            totalMatches: matchesInRequest + matchesInResponses
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
          '<span class="match-info">' + result.matchesInResponses + ' in responses</span>' : '';
        
        li.innerHTML = 
          '<a class="result-link" data-index="' + result.index + '">' +
            '<span>Conversation #' + (result.index + 1) + ' (' + result.timestamp + ')</span>' +
            '<span>' +
              requestMatches + (requestMatches && responseMatches ? ' | ' : '') + responseMatches +
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