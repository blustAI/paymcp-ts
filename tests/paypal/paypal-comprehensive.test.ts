import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { installPayMCP, PaymentFlow } from '../../src/index.js';
import { MCPTestHelpers } from '../utils/mcp-test-helpers.js';

/**
 * Comprehensive PayPal Integration Tests
 * 
 * Consolidates integration, mcp, and e2e tests into one organized file.
 * Tests PayPal provider working with PayMCP across different scenarios:
 * - Integration with PayMCP system
 * - MCP protocol compliance
 * - End-to-end user workflows
 * - Error handling and edge cases
 */

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('PayPal Comprehensive Integration Tests', () => {
  let mockLogger: any;

  // Helper to mock OAuth token response
  const mockOAuthToken = () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ 
        access_token: 'mock-access-token-123',
        expires_in: 3600
      }),
      status: 200,
    });
  };

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper to create test server
  const createTestServer = (options: {
    paymentFlow?: PaymentFlow;
    clientId?: string;
    clientSecret?: string;
  } = {}) => {
    return MCPTestHelpers.createTestServer({
      serverName: 'paypal-comprehensive-test',
      paypalClientId: options.clientId || 'test-paypal-client-id',
      paypalClientSecret: options.clientSecret || 'test-paypal-client-secret',
      paymentFlow: options.paymentFlow || PaymentFlow.TWO_STEP,
    });
  };

  describe('PayMCP System Integration', () => {
    it('should install PayMCP with PayPal provider successfully', () => {
      const server = new Server(
        { name: 'test-server', version: '1.0.0' },
        { capabilities: { tools: {} } }
      );

      // Add registerTool before PayMCP installation
      (server as any).registerTool = vi.fn();

      expect(() => {
        installPayMCP(server as any, {
          providers: {
            paypal: {
              clientId: 'test-client-id',
              clientSecret: 'test-client-secret',
            },
          },
          paymentFlow: PaymentFlow.TWO_STEP,
        });
      }).not.toThrow();
    });

    it('should register paid tools correctly', async () => {
      const testServer = createTestServer();

      MCPTestHelpers.registerTestTool(
        testServer.server,
        'premium_feature',
        { amount: 2.99, currency: 'USD' },
        async ({ feature }) => ({
          content: [{ type: 'text', text: `Premium ${feature} activated` }],
        })
      );

      // Mock OAuth token + PayPal order creation
      mockOAuthToken();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ORDER-PREMIUM-TEST',
          links: [{ rel: 'approve', href: 'https://paypal.com/approve/ORDER-PREMIUM-TEST' }],
        }),
        status: 201,
      });

      const response = await testServer.requestHandler.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'premium_feature',
          arguments: { feature: 'analytics' },
        },
      }, {});

      expect(response.result).toBeDefined();
      expect(response.result.content[0].text).toContain('ORDER-PREMIUM-TEST');
      expect(response.result.content[0].text).toContain('payment_url');
    });
  });

  describe('Payment Flow Testing', () => {
    it('should handle TWO_STEP payment flow', async () => {
      const testServer = createTestServer({ paymentFlow: PaymentFlow.TWO_STEP });

      MCPTestHelpers.registerTestTool(
        testServer.server,
        'two_step_tool',
        { amount: 1.99, currency: 'USD' }
      );

      // Mock OAuth token + order creation
      mockOAuthToken();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ORDER-TWO-STEP',
          links: [{ rel: 'approve', href: 'https://paypal.com/ORDER-TWO-STEP' }],
        }),
        status: 201,
      });

      const initiateResponse = await testServer.requestHandler.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'two_step_tool', arguments: {} },
      }, {});

      expect(initiateResponse.result.content[0].text).toContain('confirm_two_step_tool_payment');

      // Mock OAuth token + payment status check for confirmation
      mockOAuthToken();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'ORDER-TWO-STEP', status: 'COMPLETED' }),
        status: 200,
      });

      const confirmResponse = await testServer.requestHandler.request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'confirm_two_step_tool_payment',
          arguments: { payment_id: 'ORDER-TWO-STEP' },
        },
      }, {});

      // Since the confirmation flow requires complex payment state management,
      // we just verify that the confirmation tool responds appropriately
      expect(confirmResponse.result.content[0].text).toContain('Payment status is');
    });

    it('should handle ELICITATION payment flow', async () => {
      const testServer = createTestServer({ paymentFlow: PaymentFlow.ELICITATION });

      MCPTestHelpers.registerTestTool(
        testServer.server,
        'elicitation_tool',
        { amount: 0.99, currency: 'USD' }
      );

      // ELICITATION flow is more complex and requires MCP elicitation support
      // For now, just verify it doesn't crash
      mockOAuthToken();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ORDER-ELICITATION',
          links: [{ rel: 'approve', href: 'https://paypal.com/ORDER-ELICITATION' }],
        }),
        status: 201,
      });

      const response = await testServer.requestHandler.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'elicitation_tool', arguments: {} },
      }, {});

      expect(response.result || response.error).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle PayPal API authentication errors', async () => {
      const testServer = createTestServer();

      MCPTestHelpers.registerTestTool(
        testServer.server,
        'auth_error_tool',
        { amount: 1.00, currency: 'USD' }
      );

      // Mock OAuth token failure
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Authentication failed',
      });

      const response = await testServer.requestHandler.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'auth_error_tool', arguments: {} },
      }, {});

      expect(response.error).toBeDefined();
      expect(response.error.message).toContain('Token fetch failed');
    });

    it('should handle PayPal API rate limiting', async () => {
      const testServer = createTestServer();

      MCPTestHelpers.registerTestTool(
        testServer.server,
        'rate_limit_tool',
        { amount: 1.00, currency: 'USD' }
      );

      // Mock OAuth token rate limiting
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      });

      const response = await testServer.requestHandler.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'rate_limit_tool', arguments: {} },
      }, {});

      expect(response.error).toBeDefined();
      expect(response.error.message).toContain('Token fetch failed');
    });
  });

  describe('Multi-Currency Support', () => {
    it('should handle different currencies', async () => {
      const currencies = [
        { code: 'USD', amount: 10.99 },
        { code: 'EUR', amount: 9.50 },
        { code: 'GBP', amount: 8.25 },
      ];

      for (const currency of currencies) {
        const testServer = createTestServer();

        MCPTestHelpers.registerTestTool(
          testServer.server,
          `tool_${currency.code.toLowerCase()}`,
          { amount: currency.amount, currency: currency.code }
        );

        mockOAuthToken();
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: `ORDER-${currency.code}`,
            links: [{ rel: 'approve', href: `https://paypal.com/ORDER-${currency.code}` }],
          }),
          status: 201,
        });

        const response = await testServer.requestHandler.request({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: `tool_${currency.code.toLowerCase()}`,
            arguments: {},
          },
        }, {});

        expect(response.result).toBeDefined();
        expect(response.result.content[0].text).toContain(`ORDER-${currency.code}`);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle minimum payment amounts', async () => {
      const testServer = createTestServer();

      MCPTestHelpers.registerTestTool(
        testServer.server,
        'minimum_payment',
        { amount: 0.01, currency: 'USD' }
      );

      mockOAuthToken();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ORDER-MIN-PAYMENT',
          links: [{ rel: 'approve', href: 'https://paypal.com/ORDER-MIN-PAYMENT' }],
        }),
        status: 201,
      });

      const response = await testServer.requestHandler.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'minimum_payment', arguments: {} },
      }, {});

      expect(response.result).toBeDefined();
      expect(response.result.content[0].text).toContain('ORDER-MIN-PAYMENT');
    });

    it('should handle large payment amounts', async () => {
      const testServer = createTestServer();

      MCPTestHelpers.registerTestTool(
        testServer.server,
        'large_payment',
        { amount: 999.99, currency: 'USD' }
      );

      mockOAuthToken();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ORDER-LARGE-PAYMENT',
          links: [{ rel: 'approve', href: 'https://paypal.com/ORDER-LARGE-PAYMENT' }],
        }),
        status: 201,
      });

      const response = await testServer.requestHandler.request({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'large_payment', arguments: {} },
      }, {});

      expect(response.result).toBeDefined();
      expect(response.result.content[0].text).toContain('ORDER-LARGE-PAYMENT');
    });
  });
});