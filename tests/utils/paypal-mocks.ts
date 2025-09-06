import { vi } from 'vitest';

/**
 * PayPal API Mock Utilities
 * 
 * Provides realistic mock responses for PayPal API endpoints
 * to support comprehensive testing without external dependencies.
 */

export interface MockOrderResponse {
  id: string;
  status: 'CREATED' | 'APPROVED' | 'CAPTURED' | 'COMPLETED' | 'CANCELLED' | 'PAYER_ACTION_REQUIRED';
  links: Array<{
    rel: string;
    href: string;
    method?: string;
  }>;
  purchase_units?: Array<{
    amount: {
      currency_code: string;
      value: string;
    };
    description?: string;
  }>;
  payment_source?: any;
  create_time?: string;
  update_time?: string;
}

export class PayPalMockFactory {
  /**
   * Generate a realistic PayPal order creation response
   */
  static createOrderResponse(orderId: string, options: {
    status?: MockOrderResponse['status'];
    amount?: string;
    currency?: string;
    description?: string;
  } = {}): MockOrderResponse {
    const {
      status = 'CREATED',
      amount = '10.00',
      currency = 'USD',
      description = 'Test payment'
    } = options;

    return {
      id: orderId,
      status,
      links: [
        {
          rel: 'self',
          href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`,
          method: 'GET'
        },
        {
          rel: 'approve',
          href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
          method: 'GET'
        },
        {
          rel: 'update',
          href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`,
          method: 'PATCH'
        },
        {
          rel: 'capture',
          href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}/capture`,
          method: 'POST'
        }
      ],
      purchase_units: [{
        amount: {
          currency_code: currency.toUpperCase(),
          value: amount,
        },
        description,
      }],
      create_time: new Date().toISOString(),
      update_time: new Date().toISOString(),
    };
  }

  /**
   * Generate a PayPal order status response
   */
  static orderStatusResponse(orderId: string, status: MockOrderResponse['status'], options: {
    amount?: string;
    currency?: string;
    payerEmail?: string;
  } = {}): MockOrderResponse {
    const {
      amount = '10.00',
      currency = 'USD',
      payerEmail = 'test@example.com'
    } = options;

    const baseResponse = this.createOrderResponse(orderId, { status, amount, currency });

    // Add payment source info for completed payments
    if (status === 'COMPLETED' || status === 'APPROVED') {
      baseResponse.payment_source = {
        paypal: {
          email_address: payerEmail,
          account_id: 'TESTACCOUNTID123',
        }
      };
    }

    return baseResponse;
  }

  /**
   * Generate PayPal error responses
   */
  static errorResponse(errorType: 'AUTHENTICATION_FAILURE' | 'INVALID_REQUEST' | 'RESOURCE_NOT_FOUND' | 'RATE_LIMIT_REACHED', details?: string) {
    const errors = {
      AUTHENTICATION_FAILURE: {
        status: 401,
        body: {
          name: 'AUTHENTICATION_FAILURE',
          message: 'Authentication failed due to invalid authentication credentials or a missing Authorization header.',
          details: [{
            issue: 'INVALID_CLIENT_CREDENTIALS',
            description: 'Client authentication failed'
          }]
        }
      },
      INVALID_REQUEST: {
        status: 422,
        body: {
          name: 'UNPROCESSABLE_ENTITY',
          message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
          details: [{
            field: 'purchase_units',
            value: 'invalid',
            issue: 'INVALID_PARAMETER_VALUE',
            description: details || 'Invalid parameter value'
          }]
        }
      },
      RESOURCE_NOT_FOUND: {
        status: 404,
        body: {
          name: 'RESOURCE_NOT_FOUND',
          message: 'The specified resource does not exist.',
          details: [{
            issue: 'INVALID_RESOURCE_ID',
            description: 'Specified resource ID does not exist.'
          }]
        }
      },
      RATE_LIMIT_REACHED: {
        status: 429,
        body: {
          name: 'RATE_LIMIT_REACHED',
          message: 'Rate limit reached for requests',
          details: [{
            issue: 'RATE_LIMIT_EXCEEDED',
            description: 'Number of requests exceeded the limit'
          }]
        }
      }
    };

    return errors[errorType];
  }

  /**
   * Create a mock fetch function with predefined responses
   */
  static createMockFetch() {
    return vi.fn();
  }

  /**
   * Setup common PayPal API mock scenarios
   */
  static setupCommonMocks(mockFetch: any) {
    return {
      /**
       * Mock successful order creation
       */
      mockSuccessfulOrderCreation: (orderId = 'ORDER-MOCK-SUCCESS') => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => this.createOrderResponse(orderId),
        });
        return orderId;
      },

      /**
       * Mock successful order status check
       */
      mockOrderStatus: (orderId: string, status: MockOrderResponse['status'] = 'COMPLETED') => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => this.orderStatusResponse(orderId, status),
        });
      },

      /**
       * Mock authentication failure
       */
      mockAuthFailure: () => {
        const error = this.errorResponse('AUTHENTICATION_FAILURE');
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: error.status,
          text: async () => JSON.stringify(error.body),
        });
      },

      /**
       * Mock network error
       */
      mockNetworkError: (message = 'Network error') => {
        mockFetch.mockRejectedValueOnce(new Error(message));
      },

      /**
       * Mock rate limiting
       */
      mockRateLimit: () => {
        const error = this.errorResponse('RATE_LIMIT_REACHED');
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: error.status,
          text: async () => JSON.stringify(error.body),
          headers: new Map([['Retry-After', '60']]),
        });
      },

      /**
       * Mock complete payment flow (create -> status checks -> completion)
       */
      mockCompletePaymentFlow: (orderId = 'ORDER-COMPLETE-FLOW') => {
        // Order creation
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => this.createOrderResponse(orderId),
        });

        // Status check 1: CREATED
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => this.orderStatusResponse(orderId, 'CREATED'),
        });

        // Status check 2: APPROVED
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => this.orderStatusResponse(orderId, 'APPROVED'),
        });

        // Status check 3: COMPLETED
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => this.orderStatusResponse(orderId, 'COMPLETED'),
        });

        return orderId;
      },
    };
  }
}

/**
 * Logger mock factory
 */
export class MockLoggerFactory {
  static create() {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };
  }

  static createWithCapture() {
    const logs: Array<{ level: string; message: string; args: any[] }> = [];
    
    const logger = {
      debug: vi.fn((...args) => logs.push({ level: 'debug', message: args[0], args: args.slice(1) })),
      info: vi.fn((...args) => logs.push({ level: 'info', message: args[0], args: args.slice(1) })),
      warn: vi.fn((...args) => logs.push({ level: 'warn', message: args[0], args: args.slice(1) })),
      error: vi.fn((...args) => logs.push({ level: 'error', message: args[0], args: args.slice(1) })),
      log: vi.fn((...args) => logs.push({ level: 'log', message: args[0], args: args.slice(1) })),
      getLogs: () => [...logs],
      clearLogs: () => logs.length = 0,
    };

    return logger;
  }
}

/**
 * Test data generators
 */
export class TestDataFactory {
  /**
   * Generate realistic payment scenarios
   */
  static paymentScenarios() {
    return [
      {
        name: 'Basic USD payment',
        amount: 10.00,
        currency: 'USD',
        description: 'Basic test payment',
        expectedValue: '10.00',
      },
      {
        name: 'Euro payment',
        amount: 25.50,
        currency: 'EUR',
        description: 'European payment test',
        expectedValue: '25.50',
      },
      {
        name: 'Small amount',
        amount: 0.01,
        currency: 'USD',
        description: 'Minimum payment test',
        expectedValue: '0.01',
      },
      {
        name: 'Large amount',
        amount: 999.99,
        currency: 'USD',
        description: 'Large payment test',
        expectedValue: '999.99',
      },
      {
        name: 'Fractional cents',
        amount: 12.999,
        currency: 'USD',
        description: 'Rounding test payment',
        expectedValue: '13.00',
      },
    ];
  }

  /**
   * Generate order status progression scenarios
   */
  static statusProgressions() {
    return [
      {
        name: 'Successful completion',
        stages: ['CREATED', 'APPROVED', 'COMPLETED'] as const,
      },
      {
        name: 'User cancellation',
        stages: ['CREATED', 'CANCELLED'] as const,
      },
      {
        name: 'Payer action required',
        stages: ['CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED', 'COMPLETED'] as const,
      },
    ];
  }

  /**
   * Generate test tool configurations
   */
  static testTools() {
    return [
      {
        name: 'basic_tool',
        config: {
          title: 'Basic Tool',
          description: 'Basic paid tool for testing',
          inputSchema: {
            type: 'object',
            properties: {
              input: { type: 'string' },
            },
            required: ['input'],
          },
          price: { amount: 1.00, currency: 'USD' },
        },
        handler: async ({ input }: { input: string }) => ({
          content: [{ type: 'text', text: `Processed: ${input}` }],
        }),
      },
      {
        name: 'premium_tool',
        config: {
          title: 'Premium Tool',
          description: 'Expensive premium tool',
          inputSchema: {
            type: 'object',
            properties: {
              complexity: { type: 'number', minimum: 1, maximum: 10 },
            },
            required: ['complexity'],
          },
          price: { amount: 10.00, currency: 'USD' },
        },
        handler: async ({ complexity }: { complexity: number }) => ({
          content: [{ type: 'text', text: `Premium processing at complexity level ${complexity}` }],
        }),
      },
    ];
  }
}