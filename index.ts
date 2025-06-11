import { Elysia } from 'elysia';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
// 会话管理
const sessions: Record<string, { transport: StreamableHTTPServerTransport }> = {};
// HTTP 请求工具函数
async function makeHttpRequest(config: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
}) {
  const { url, method = 'GET', headers = {}, body, timeout = 30000 } = config;
  
  try {
    const requestInit: RequestInit = {
      method: method.toUpperCase(),
      headers: { 'User-Agent': 'MCP-HTTP-Client/1.0.0', ...headers },
      signal: AbortSignal.timeout(timeout)
    };
    if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      if (typeof body === 'string') {
        requestInit.body = body;
      } else {
        requestInit.body = JSON.stringify(body);
        if (!headers['Content-Type']) {
          (requestInit.headers as any)['Content-Type'] = 'application/json';
        }
      }
    }
    const response = await fetch(url, requestInit);
    
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
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
  } catch (error: any) {
    return { error: true, message: error.message };
  }
}
// 创建 MCP 服务器
function createMcpServer() {
  const server = new McpServer({ name: 'HTTP-Request-Server', version: '1.0.0' });
  // HTTP 请求工具
  server.tool('http_request', {
    url: z.string().url(),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).default('GET'),
    headers: z.record(z.string()).optional(),
    body: z.any().optional(),
    timeout: z.number().default(30000)
  }, async ({ url, method, headers, body, timeout }) => {
    const result = await makeHttpRequest({ url, method, headers, body, timeout });
    
    if ('error' in result) {
      return {
        content: [{ type: 'text', text: `❌ 请求失败: ${result.message}` }],
        isError: true
      };
    }
    const icon = result.ok ? '✅' : '❌';
    return {
      content: [{
        type: 'text',
        text: `${icon} ${method.toUpperCase()} ${url}\n状态: ${result.status} ${result.statusText}\n\n响应头:\n${Object.entries(result.headers).map(([k,v]) => `${k}: ${v}`).join('\n')}\n\n响应体:\n${typeof result.body === 'object' ? JSON.stringify(result.body, null, 2) : result.body}`
      }]
    };
  });
  return server;
}
// CORS 头部
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id'
};
const app = new Elysia();
// OPTIONS 请求处理
app.options('/mcp', () => {
  return new Response('', { status: 200, headers: corsHeaders });
});
// POST 请求处理
app.post('/mcp', async ({ body, headers }) => {
  console.log('POST /mcp', headers['mcp-session-id']);
  
  const sessionId = headers['mcp-session-id'] as string;
  let transport: StreamableHTTPServerTransport;
  try {
    if (sessionId && sessions[sessionId]) {
      transport = sessions[sessionId].transport;
    } else if (!sessionId && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions[id] = { transport }; }
      });
      transport.onclose = () => { 
        if (transport.sessionId) delete sessions[transport.sessionId]; 
      };
      
      const server = createMcpServer();
      await server.connect(transport);
    } else {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request' },
        id: null
      }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json', ...corsHeaders } 
      });
    }
    return new Promise((resolve) => {
      const req = { method: 'POST', headers, body: JSON.stringify(body), url: '/mcp' };
      const res = {
        headersSent: false,
        statusCode: 200,
        _headers: {} as Record<string, string>,
        setHeader: function(k: string, v: string) { this._headers[k] = v; },
        writeHead: function(status: number) { this.statusCode = status; return this; },
        write: () => true,
        end: function(data?: any) {
          const response = new Response(data || '', {
            status: this.statusCode,
            headers: { 
              'Content-Type': 'application/json',
              ...corsHeaders,
              ...this._headers 
            }
          });
          resolve(response);
        }
      };
      
      transport.handleRequest(req as any, res as any, body);
    });
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal Error' },
      id: null
    }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json', ...corsHeaders } 
    });
  }
});
// GET 请求处理
app.get('/mcp', async ({ headers }) => {
  const sessionId = headers['mcp-session-id'] as string;
  
  if (!sessionId || !sessions[sessionId]) {
    return new Response('Invalid session', { 
      status: 400, 
      headers: corsHeaders 
    });
  }
  
  const transport = sessions[sessionId].transport;
  
  return new Promise((resolve) => {
    const req = { method: 'GET', headers, url: '/mcp' };
    const res = {
      headersSent: false,
      statusCode: 200,
      _headers: {} as Record<string, string>,
      setHeader: function(k: string, v: string) { this._headers[k] = v; },
      writeHead: function(status: number) { this.statusCode = status; return this; },
      write: () => true,
      end: function(data?: any) {
        resolve(new Response(data || '', {
          status: this.statusCode,
          headers: { ...corsHeaders, ...this._headers }
        }));
      }
    };
    
    transport.handleRequest(req as any, res as any);
  });
});
// DELETE 请求处理
app.delete('/mcp', async ({ headers }) => {
  const sessionId = headers['mcp-session-id'] as string;
  
  if (sessionId && sessions[sessionId]) {
    delete sessions[sessionId];
  }
  
  return new Response('', { status: 200, headers: corsHeaders });
});
// 健康检查
app.get('/health', () => {
  return new Response(JSON.stringify({ 
    status: 'ok', 
    sessions: Object.keys(sessions).length 
  }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
});
// 启动服务器
app.listen(3000, () => {
  console.log('🚀 HTTP MCP Server 启动在端口 3000');
  console.log('🔧 健康检查: http://localhost:3000/health');
  console.log('🌐 MCP 端点: http://localhost:3000/mcp');
});