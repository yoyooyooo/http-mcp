import { Elysia } from 'elysia';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
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
// 解析 CURL 命令
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
  // CURL 请求工具
  server.tool('curl_request', {
    curl_command: z.string().describe('CURL command string'),
    timeout: z.number().default(30000)
  }, async ({ curl_command, timeout }) => {
    try {
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
          content: [{ type: 'text', text: `❌ CURL 请求失败: ${result.message}\n命令: ${curl_command}` }],
          isError: true
        };
      }
      const icon = result.ok ? '✅' : '❌';
      return {
        content: [{
          type: 'text',
          text: `${icon} CURL: ${curl_command}\n状态: ${result.status} ${result.statusText}\n\n响应头:\n${Object.entries(result.headers).map(([k,v]) => `${k}: ${v}`).join('\n')}\n\n响应体:\n${typeof result.body === 'object' ? JSON.stringify(result.body, null, 2) : result.body}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `❌ 解析 CURL 命令失败: ${error.message}\n命令: ${curl_command}` }],
        isError: true
      };
    }
  });
  return server;
}
// CORS 头部
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id'
};
// 创建兼容 Node.js 的 Response 对象
class MockResponse extends EventEmitter {
  headersSent = false;
  statusCode = 200;
  _headers: Record<string, string> = {};
  _data: any = undefined;
  setHeader(name: string, value: string) {
    this._headers[name] = value;
  }
  writeHead(statusCode: number, headers?: Record<string, string>) {
    this.statusCode = statusCode;
    if (headers) {
      Object.assign(this._headers, headers);
    }
    return this;
  }
  write(chunk: any) {
    return true;
  }
  end(data?: any) {
    this._data = data;
    this.emit('finish');
  }
}
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
        onsessioninitialized: (id) => { 
          console.log('Session initialized:', id);
          sessions[id] = { transport }; 
        }
      });
      transport.onclose = () => { 
        console.log('Session closed:', transport.sessionId);
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
    return new Promise<Response>((resolve) => {
      const req = { 
        method: 'POST', 
        headers, 
        body: JSON.stringify(body), 
        url: '/mcp' 
      };
      
      const res = new MockResponse();
      
      res.on('finish', () => {
        const response = new Response(res._data || '', {
          status: res.statusCode,
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders,
            ...res._headers 
          }
        });
        resolve(response);
      });
      
      transport.handleRequest(req as any, res as any, body).catch((error) => {
        console.error('Transport error:', error);
        resolve(new Response(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal Error' },
          id: null
        }), { 
          status: 500, 
          headers: { 'Content-Type': 'application/json', ...corsHeaders } 
        }));
      });
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
  
  return new Promise<Response>((resolve) => {
    const req = { method: 'GET', headers, url: '/mcp' };
    const res = new MockResponse();
    
    res.on('finish', () => {
      resolve(new Response(res._data || '', {
        status: res.statusCode,
        headers: { ...corsHeaders, ...res._headers }
      }));
    });
    
    transport.handleRequest(req as any, res as any).catch((error) => {
      console.error('Transport error:', error);
      resolve(new Response('Internal Error', { 
        status: 500, 
        headers: corsHeaders 
      }));
    });
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
    sessions: Object.keys(sessions).length,
    activeSessions: Object.keys(sessions)
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