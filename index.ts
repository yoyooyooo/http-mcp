import { Elysia } from 'elysia';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
const app = new Elysia();
// Session management for stateful connections
const sessions: Record<string, { transport: StreamableHTTPServerTransport }> = {};
// Helper function to create HTTP client
async function makeHttpRequest({
  url,
  method = 'GET',
  headers = {},
  body,
  timeout = 30000
}: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
}) {
  try {
    const requestInit: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        'User-Agent': 'MCP-HTTP-Client/1.0.0',
        ...headers
      },
      signal: AbortSignal.timeout(timeout)
    };
    // Add body for POST, PUT, PATCH requests
    if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      if (typeof body === 'string') {
        requestInit.body = body;
      } else {
        requestInit.body = JSON.stringify(body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          (requestInit.headers as Record<string, string>)['Content-Type'] = 'application/json';
        }
      }
    }
    const response = await fetch(url, requestInit);
    
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    let responseBody: any;
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      try {
        responseBody = await response.json();
      } catch {
        responseBody = await response.text();
      }
    } else {
      responseBody = await response.text();
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      url: response.url,
      ok: response.ok
    };
  } catch (error) {
    if (error instanceof Error) {
      return {
        error: true,
        message: error.message,
        name: error.name
      };
    }
    return {
      error: true,
      message: 'Unknown error occurred'
    };
  }
}
// Create MCP server instance
function createMcpServer() {
  const server = new McpServer({ 
    name: 'HTTP-Request-Server', 
    version: '1.0.0' 
  });
  // Tool for making HTTP requests
  server.tool(
    'http_request',
    {
      url: z.string().url('Must be a valid URL'),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).default('GET'),
      headers: z.record(z.string()).optional().describe('HTTP headers as key-value pairs'),
      body: z.any().optional().describe('Request body (will be JSON stringified if object)'),
      timeout: z.number().min(1000).max(300000).default(30000).describe('Request timeout in milliseconds')
    },
    async ({ url, method, headers, body, timeout }) => {
      const result = await makeHttpRequest({ url, method, headers, body, timeout });
      
      if ('error' in result) {
        return {
          content: [{
            type: 'text',
            text: `❌ HTTP Request Failed:\nError: ${result.message}\nType: ${result.name}`
          }],
          isError: true
        };
      }
      const statusIcon = result.ok ? '✅' : '❌';
      const resultText = `${statusIcon} HTTP ${method.toUpperCase()} Request to ${url}
**Status:** ${result.status} ${result.statusText}
**URL:** ${result.url}
**Response Headers:**
${Object.entries(result.headers).map(([key, value]) => `${key}: ${value}`).join('\n')}
**Response Body:**
${typeof result.body === 'object' ? JSON.stringify(result.body, null, 2) : result.body}`;
      return {
        content: [{
          type: 'text',
          text: resultText
        }]
      };
    }
  );
  // Tool for making CURL-like requests with easier syntax
  server.tool(
    'curl_request',
    {
      curl_command: z.string().describe('CURL command string (e.g., "curl -X POST https://api.example.com -H \'Content-Type: application/json\' -d \'{}\'")'),
      timeout: z.number().min(1000).max(300000).default(30000).describe('Request timeout in milliseconds')
    },
    async ({ curl_command, timeout }) => {
      try {
        // Simple CURL parser (basic implementation)
        const parsed = parseCurlCommand(curl_command);
        const result = await makeHttpRequest({ 
          url: parsed.url, 
          method: parsed.method, 
          headers: parsed.headers, 
          body: parsed.body,
          timeout 
        });
        
        if ('error' in result) {
          return {
            content: [{
              type: 'text',
              text: `❌ CURL Request Failed:\nError: ${result.message}\nOriginal command: ${curl_command}`
            }],
            isError: true
          };
        }
        const statusIcon = result.ok ? '✅' : '❌';
        const resultText = `${statusIcon} CURL Request: ${curl_command}
**Status:** ${result.status} ${result.statusText}
**URL:** ${result.url}
**Response Headers:**
${Object.entries(result.headers).map(([key, value]) => `${key}: ${value}`).join('\n')}
**Response Body:**
${typeof result.body === 'object' ? JSON.stringify(result.body, null, 2) : result.body}`;
        return {
          content: [{
            type: 'text',
            text: resultText
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `❌ Failed to parse CURL command: ${error instanceof Error ? error.message : 'Unknown error'}\nCommand: ${curl_command}`
          }],
          isError: true
        };
      }
    }
  );
  // Resource for API documentation
  server.resource(
    'api-docs',
    'docs://http-client',
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: `# HTTP Request MCP Server
This server provides tools to make HTTP requests from within MCP conversations.
## Available Tools:
### 1. http_request
Make structured HTTP requests with full control over headers, method, and body.
**Parameters:**
- url: The target URL (required)
- method: HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS)
- headers: Object of HTTP headers
- body: Request body (will be JSON stringified if object)
- timeout: Request timeout in milliseconds (default: 30000)
### 2. curl_request
Execute CURL-like commands with a familiar syntax.
**Parameters:**
- curl_command: CURL command string
- timeout: Request timeout in milliseconds
## Examples:
### Basic GET request:
\`\`\`
http_request({
  url: "https://jsonplaceholder.typicode.com/posts/1",
  method: "GET"
})
\`\`\`
### POST with JSON body:
\`\`\`
http_request({
  url: "https://jsonplaceholder.typicode.com/posts",
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: { title: "Test", body: "Test content", userId: 1 }
})
\`\`\`
### CURL-style request:
\`\`\`
curl_request({
  curl_command: "curl -X POST https://httpbin.org/post -H 'Content-Type: application/json' -d '{\"key\":\"value\"}'"
})
\`\`\`
`
      }]
    })
  );
  return server;
}
// Simple CURL command parser
function parseCurlCommand(curlCommand: string) {
  const parts = curlCommand.split(/\s+/);
  let url = '';
  let method = 'GET';
  const headers: Record<string, string> = {};
  let body: any = undefined;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    
    if (part === 'curl') continue;
    
    if (part === '-X' || part === '--request') {
      method = parts[++i]?.toUpperCase() || 'GET';
    } else if (part === '-H' || part === '--header') {
      const header = parts[++i]?.replace(/['"]/g, '');
      if (header) {
        const [key, ...valueParts] = header.split(':');
        if (key && valueParts.length > 0) {
          headers[key.trim()] = valueParts.join(':').trim();
        }
      }
    } else if (part === '-d' || part === '--data') {
      const data = parts[++i]?.replace(/^['"]|['"]$/g, '');
      if (data) {
        try {
          body = JSON.parse(data);
        } catch {
          body = data;
        }
      }
    } else if (!part.startsWith('-') && !url) {
      url = part.replace(/['"]/g, '');
    }
  }
  if (!url) {
    throw new Error('No URL found in CURL command');
  }
  return { url, method, headers, body };
}
// Add CORS middleware properly
app.use(async ({ set }) => {
  set.headers['Access-Control-Allow-Origin'] = '*';
  set.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  set.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, mcp-session-id';
});
// Handle OPTIONS requests for CORS
app.options('/mcp', ({ set }) => {
  set.headers['Access-Control-Allow-Origin'] = '*';
  set.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  set.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, mcp-session-id';
  set.status = 200;
  return '';
});
// Handle MCP requests with session management
app.post('/mcp', async ({ body, headers, set }) => {
  console.log('Received POST message for sessionId', headers['mcp-session-id']);
  
  const sessionId = headers['mcp-session-id'] as string | undefined;
  let transport: StreamableHTTPServerTransport;
  try {
    if (sessionId && sessions[sessionId]) {
      // Reuse existing transport
      transport = sessions[sessionId].transport;
      console.log('Reusing existing session:', sessionId);
    } else if (!sessionId && isInitializeRequest(body)) {
      // New initialization request
      console.log('Creating new session...');
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          console.log('Session initialized:', sessionId);
          sessions[sessionId] = { transport };
        }
      });
      // Clean up transport when closed
      transport.onclose = () => {
        console.log('Session closed:', transport.sessionId);
        if (transport.sessionId) {
          delete sessions[transport.sessionId];
        }
      };
      const server = createMcpServer();
      await server.connect(transport);
    } else {
      // Invalid request
      console.log('Invalid request - no session ID and not initialize');
      set.status = 400;
      set.headers['Content-Type'] = 'application/json';
      return JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
    }
    // Create a proper request/response object that the MCP transport expects
    const req = {
      method: 'POST',
      headers: headers as Record<string, string>,
      body: JSON.stringify(body),
      url: '/mcp'
    };
    let responseData: any = undefined;
    let responseStatus = 200;
    let responseHeaders: Record<string, string> = {};
    const res = {
      headersSent: false,
      statusCode: 200,
      
      setHeader(name: string, value: string) {
        responseHeaders[name] = value;
      },
      
      writeHead(statusCode: number, headers?: Record<string, string>) {
        responseStatus = statusCode;
        if (headers) {
          Object.assign(responseHeaders, headers);
        }
        return this;
      },
      
      write(chunk: any) {
        return true;
      },
      
      end(data?: any) {
        responseData = data;
      }
    };
    // Handle the request
    await transport.handleRequest(req as any, res as any, body);
    
    // Set response status and headers
    set.status = responseStatus;
    Object.entries(responseHeaders).forEach(([key, value]) => {
      set.headers[key] = value;
    });
    
    // Return the response data
    if (responseData) {
      try {
        return JSON.parse(responseData);
      } catch {
        return responseData;
      }
    }
    
    return undefined;
  } catch (error) {
    console.error('Error in POST /mcp:', error);
    set.status = 500;
    set.headers['Content-Type'] = 'application/json';
    return JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error',
      },
      id: null,
    });
  }
});
// Handle GET requests for server-to-client notifications
app.get('/mcp', async ({ headers, set }) => {
  console.log('Received GET request for sessionId', headers['mcp-session-id']);
  
  const sessionId = headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions[sessionId]) {
    set.status = 400;
    return 'Invalid or missing session ID';
  }
  
  const transport = sessions[sessionId].transport;
  
  const req = {
    method: 'GET',
    headers: headers as Record<string, string>,
    url: '/mcp'
  };
  let responseData: any = undefined;
  let responseStatus = 200;
  let responseHeaders: Record<string, string> = {};
  const res = {
    headersSent: false,
    statusCode: 200,
    
    setHeader(name: string, value: string) {
      responseHeaders[name] = value;
    },
    
    writeHead(statusCode: number, headers?: Record<string, string>) {
      responseStatus = statusCode;
      if (headers) {
        Object.assign(responseHeaders, headers);
      }
      return this;
    },
    
    write(chunk: any) {
      return true;
    },
    
    end(data?: any) {
      responseData = data;
    }
  };
  await transport.handleRequest(req as any, res as any);
  
  // Set response status and headers
  set.status = responseStatus;
  Object.entries(responseHeaders).forEach(([key, value]) => {
    set.headers[key] = value;
  });
  
  if (responseData) {
    try {
      return JSON.parse(responseData);
    } catch {
      return responseData;
    }
  }
  
  return undefined;
});
// Handle DELETE requests for session termination
app.delete('/mcp', async ({ headers, set }) => {
  console.log('Received DELETE request for sessionId', headers['mcp-session-id']);
  
  const sessionId = headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions[sessionId]) {
    set.status = 400;
    return 'Invalid or missing session ID';
  }
  
  const transport = sessions[sessionId].transport;
  
  // Clean up the session
  delete sessions[sessionId];
  
  const req = {
    method: 'DELETE',
    headers: headers as Record<string, string>,
    url: '/mcp'
  };
  let responseData: any = undefined;
  let responseStatus = 200;
  let responseHeaders: Record<string, string> = {};
  const res = {
    headersSent: false,
    statusCode: 200,
    
    setHeader(name: string, value: string) {
      responseHeaders[name] = value;
    },
    
    writeHead(statusCode: number, headers?: Record<string, string>) {
      responseStatus = statusCode;
      if (headers) {
        Object.assign(responseHeaders, headers);
      }
      return this;
    },
    
    write(chunk: any) {
      return true;
    },
    
    end(data?: any) {
      responseData = data;
    }
  };
  await transport.handleRequest(req as any, res as any);
  
  // Set response status and headers
  set.status = responseStatus;
  Object.entries(responseHeaders).forEach(([key, value]) => {
    set.headers[key] = value;
  });
  
  if (responseData) {
    try {
      return JSON.parse(responseData);
    } catch {
      return responseData;
    }
  }
  
  return undefined;
});
// Health check endpoint
app.get('/health', () => ({
  status: 'healthy',
  timestamp: new Date().toISOString(),
  sessions: Object.keys(sessions).length,
  activeSessions: Object.keys(sessions)
}));
// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 HTTP MCP Server running on port 3000`);
  console.log(`📚 API Documentation available at: docs://http-client`);
  console.log(`🔧 Health check: http://localhost:3000/health`);
  console.log(`🌐 MCP endpoint: http://localhost:3000/mcp`);
});
export default app;