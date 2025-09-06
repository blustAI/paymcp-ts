import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { installPayMCP, PaymentFlow } from '../../src/index.js';
import { MockLoggerFactory } from './paypal-mocks.js';

/**
 * MCP Test Helpers
 * 
 * Utilities for testing MCP servers and PayPal integration
 * without external dependencies.
 */

export interface MCPTestServer {
  server: Server;
  requestHandler: any;
  logger: any;
}

export class MCPTestHelpers {
  /**
   * Create a test MCP server with PayPal provider installed
   */
  static createTestServer(options: {
    serverName?: string;
    paypalClientId?: string;
    paypalClientSecret?: string;
    paymentFlow?: PaymentFlow;
    successUrl?: string;
    cancelUrl?: string;
  } = {}): MCPTestServer {
    const {
      serverName = 'test-server',
      paypalClientId = 'test-paypal-client-id',
      paypalClientSecret = 'test-paypal-client-secret',
      paymentFlow = PaymentFlow.TWO_STEP,
      successUrl = 'https://test.com/success',
      cancelUrl = 'https://test.com/cancel',
    } = options;

    const logger = MockLoggerFactory.create();
    
    const server = new Server(
      { name: serverName, version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    // Add a default registerTool method to server before PayMCP installation
    // PayMCP expects to find this method to bind to originalRegisterTool
    (server as any).registerTool = (name: string, config: any, handler: any) => {
      // Store tools in a map for later retrieval
      if (!(server as any).tools) {
        (server as any).tools = new Map();
      }
      (server as any).tools.set(name, { config, handler });
    };

    installPayMCP(server, {
      providers: {
        paypal: {
          clientId: paypalClientId,
          clientSecret: paypalClientSecret,
          successUrl,
          cancelUrl,
          logger,
        },
      },
      paymentFlow,
      logger,
    });

    return {
      server,
      requestHandler: {
        // Mock request handler that simulates MCP protocol
        request: async (request: any, context: any) => {
          const { method, params } = request;
          
          if (method === 'initialize') {
            return {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                capabilities: { tools: {} },
                serverInfo: { name: serverName, version: '1.0.0' },
              },
            };
          }
          
          if (method === 'tools/list') {
            // Extract registered tools from server
            const tools = [];
            const toolsMap = (server as any).tools || new Map();
            for (const [name, entry] of toolsMap.entries()) {
              tools.push({
                name,
                description: entry.config.description || '',
                inputSchema: entry.config.inputSchema || { type: 'object' },
              });
            }
            
            return {
              jsonrpc: '2.0',
              id: request.id,
              result: { tools },
            };
          }
          
          if (method === 'tools/call') {
            const { name, arguments: args } = params;
            const toolsMap = (server as any).tools || new Map();
            const tool = toolsMap.get(name);
            
            if (!tool) {
              return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                  code: -32601,
                  message: `Unknown tool: ${name}`,
                },
              };
            }
            
            try {
              // Call the tool with proper signature (args, extra)
              const result = await tool.handler(args, {});
              
              // Ensure result has content property for MCP compliance
              if (!result || !result.content) {
                return {
                  jsonrpc: '2.0',
                  id: request.id,
                  result: {
                    content: [{
                      type: 'text',
                      text: String(result || 'Tool executed successfully'),
                    }],
                  },
                };
              }
              
              return {
                jsonrpc: '2.0',
                id: request.id,
                result,
              };
            } catch (error: any) {
              return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                  code: -32603,
                  message: error.message || 'Internal error',
                },
              };
            }
          }
          
          return {
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32601,
              message: `Unknown method: ${method}`,
            },
          };
        }
      },
      logger,
    };
  }

  /**
   * Register a test tool on the server
   */
  static registerTestTool(
    server: Server,
    toolName: string,
    price: { amount: number; currency: string },
    handler?: (args: any) => Promise<any>
  ) {
    const defaultHandler = async (args: any) => ({
      content: [{
        type: 'text',
        text: `Test tool ${toolName} executed with args: ${JSON.stringify(args)}`,
      }],
    });

    server.registerTool(
      toolName,
      {
        title: `Test Tool: ${toolName}`,
        description: `Test tool for ${toolName} (paid)`,
        inputSchema: {
          type: 'object',
          properties: {
            testParam: { type: 'string' },
          },
        },
        price,
      },
      handler || defaultHandler
    );
  }

  /**
   * Execute an MCP request and return the response
   */
  static async executeRequest(
    requestHandler: any,
    method: string,
    params: any = {},
    id: number = 1
  ) {
    return await requestHandler.request({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }, {});
  }

  /**
   * Call a tool through MCP protocol
   */
  static async callTool(
    requestHandler: any,
    toolName: string,
    args: any = {},
    id: number = 1
  ) {
    return await this.executeRequest(
      requestHandler,
      'tools/call',
      { name: toolName, arguments: args },
      id
    );
  }

  /**
   * List tools through MCP protocol
   */
  static async listTools(requestHandler: any, id: number = 1) {
    return await this.executeRequest(requestHandler, 'tools/list', {}, id);
  }

  /**
   * Initialize MCP connection
   */
  static async initialize(
    requestHandler: any,
    clientInfo: { name: string; version: string } = { name: 'test-client', version: '1.0.0' },
    id: number = 1
  ) {
    return await this.executeRequest(
      requestHandler,
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo,
      },
      id
    );
  }

  /**
   * Extract payment information from MCP response
   */
  static extractPaymentInfo(response: any): {
    paymentId?: string;
    paymentUrl?: string;
    confirmationTool?: string;
  } | null {
    if (!response?.result?.content?.[0]?.text) {
      return null;
    }

    const text = response.result.content[0].text;
    
    // Parse payment information from response text
    const paymentIdMatch = text.match(/payment_id["\s:]+([^"\s,}]+)/);
    const paymentUrlMatch = text.match(/payment_url["\s:]+([^"\s,}]+)/);
    const confirmationToolMatch = text.match(/next_step["\s:]+([^"\s,}]+)/);

    return {
      paymentId: paymentIdMatch?.[1],
      paymentUrl: paymentUrlMatch?.[1],
      confirmationTool: confirmationToolMatch?.[1],
    };
  }

  /**
   * Simulate a complete payment flow
   */
  static async simulatePaymentFlow(
    testServer: MCPTestServer,
    mockFetch: any,
    toolName: string,
    toolArgs: any = {},
    orderId: string = 'ORDER-TEST-FLOW'
  ) {
    // Mock order creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: orderId,
        links: [{ rel: 'approve', href: `https://paypal.com/approve/${orderId}` }],
      }),
      status: 201,
    });

    // Step 1: Call paid tool (initiate payment)
    const initiateResponse = await this.callTool(
      testServer.requestHandler,
      toolName,
      toolArgs
    );

    // Mock payment completion
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: orderId, status: 'COMPLETED' }),
      status: 200,
    });

    // Step 2: Call confirmation tool
    const confirmResponse = await this.callTool(
      testServer.requestHandler,
      `confirm_${toolName}`,
      { payment_id: orderId }
    );

    return {
      initiateResponse,
      confirmResponse,
      paymentInfo: this.extractPaymentInfo(initiateResponse),
    };
  }

  /**
   * Verify MCP response structure
   */
  static verifyMCPResponse(response: any, expectedProperties: string[] = []) {
    expect(response).toBeDefined();
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBeDefined();
    
    if (response.result) {
      expectedProperties.forEach(prop => {
        expect(response.result).toHaveProperty(prop);
      });
    }
    
    return response;
  }

  /**
   * Verify tool response content
   */
  static verifyToolContent(response: any, expectedText?: string) {
    this.verifyMCPResponse(response, ['content']);
    
    expect(response.result.content).toBeInstanceOf(Array);
    expect(response.result.content.length).toBeGreaterThan(0);
    expect(response.result.content[0]).toHaveProperty('type');
    expect(response.result.content[0]).toHaveProperty('text');
    
    if (expectedText) {
      expect(response.result.content[0].text).toContain(expectedText);
    }
    
    return response.result.content[0].text;
  }

  /**
   * Create a test scenario runner
   */
  static createScenarioRunner(testServer: MCPTestServer, mockFetch: any) {
    return {
      /**
       * Run a payment initiation scenario
       */
      async runPaymentInitiation(
        toolName: string,
        toolArgs: any,
        expectedOrderId: string,
        mockOrderResponse?: any
      ) {
        const defaultMockResponse = {
          id: expectedOrderId,
          links: [{ rel: 'approve', href: `https://paypal.com/approve/${expectedOrderId}` }],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => mockOrderResponse || defaultMockResponse,
          status: 201,
        });

        const response = await MCPTestHelpers.callTool(
          testServer.requestHandler,
          toolName,
          toolArgs
        );

        const paymentInfo = MCPTestHelpers.extractPaymentInfo(response);
        expect(paymentInfo?.paymentId).toBe(expectedOrderId);
        
        return { response, paymentInfo };
      },

      /**
       * Run a payment confirmation scenario
       */
      async runPaymentConfirmation(
        toolName: string,
        orderId: string,
        orderStatus: string = 'COMPLETED'
      ) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: orderId, status: orderStatus }),
          status: 200,
        });

        const response = await MCPTestHelpers.callTool(
          testServer.requestHandler,
          `confirm_${toolName}`,
          { payment_id: orderId }
        );

        return response;
      },

      /**
       * Run error scenario
       */
      async runErrorScenario(
        toolName: string,
        toolArgs: any,
        errorStatus: number,
        errorBody: string
      ) {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: errorStatus,
          text: async () => errorBody,
        });

        const response = await MCPTestHelpers.callTool(
          testServer.requestHandler,
          toolName,
          toolArgs
        );

        return response;
      },
    };
  }
}

/**
 * Test assertions for PayPal MCP integration
 */
export class PayPalMCPAssertions {
  /**
   * Assert that a response contains payment initiation information
   */
  static assertPaymentInitiation(response: any, expectedOrderId?: string) {
    const text = MCPTestHelpers.verifyToolContent(response);
    
    expect(text).toContain('payment_url');
    expect(text).toContain('payment_id');
    expect(text).toContain('next_step');
    
    if (expectedOrderId) {
      expect(text).toContain(expectedOrderId);
    }
    
    const paymentInfo = MCPTestHelpers.extractPaymentInfo(response);
    expect(paymentInfo).not.toBeNull();
    expect(paymentInfo!.paymentId).toBeDefined();
    expect(paymentInfo!.paymentUrl).toBeDefined();
    expect(paymentInfo!.confirmationTool).toBeDefined();
    
    return paymentInfo!;
  }

  /**
   * Assert that a response contains successful tool execution
   */
  static assertToolExecution(response: any, expectedContent?: string) {
    const text = MCPTestHelpers.verifyToolContent(response);
    
    // Should not contain payment-related information
    expect(text).not.toContain('payment_url');
    expect(text).not.toContain('payment_id');
    expect(text).not.toContain('next_step');
    
    if (expectedContent) {
      expect(text).toContain(expectedContent);
    }
    
    return text;
  }

  /**
   * Assert that a response contains an error
   */
  static assertError(response: any, expectedErrorCode?: number) {
    expect(response).toBeDefined();
    expect(response.error || response.result?.isError).toBeDefined();
    
    if (expectedErrorCode && response.error) {
      expect(response.error.code).toBe(expectedErrorCode);
    }
    
    return response.error;
  }

  /**
   * Assert that tools are properly registered
   */
  static assertToolsRegistered(toolsResponse: any, expectedTools: string[]) {
    MCPTestHelpers.verifyMCPResponse(toolsResponse, ['tools']);
    
    const tools = toolsResponse.result.tools;
    expect(tools).toBeInstanceOf(Array);
    
    const toolNames = tools.map((tool: any) => tool.name);
    
    expectedTools.forEach(toolName => {
      expect(toolNames).toContain(toolName);
      
      // For paid tools, should also have confirmation tool
      if (tools.find((t: any) => t.name === toolName && t.description?.includes('paid'))) {
        expect(toolNames).toContain(`confirm_${toolName}`);
      }
    });
    
    return tools;
  }
}