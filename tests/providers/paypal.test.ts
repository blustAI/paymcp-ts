import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PayPalProvider } from '../../src/providers/paypal.js';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('PayPalProvider Unit Tests', () => {
  let provider: PayPalProvider;
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
    
    provider = new PayPalProvider({
      clientId: 'test-client-id-12345',
      clientSecret: 'test-client-secret-67890',
      successUrl: 'https://example.com/success?token={token}',
      cancelUrl: 'https://example.com/cancel',
      logger: mockLogger,
    });
    
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default URLs when not provided', () => {
      const defaultProvider = new PayPalProvider({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        logger: mockLogger,
      });
      
      expect(defaultProvider).toBeDefined();
    });

    it('should use custom URLs when provided', () => {
      expect(provider).toBeDefined();
    });
  });

  describe('createPayment', () => {
    it('should create a PayPal order successfully', async () => {
      mockOAuthToken();
      
      const mockResponse = {
        id: 'ORDER-12345ABC',
        links: [
          { rel: 'self', href: 'https://api.paypal.com/v2/checkout/orders/ORDER-12345ABC' },
          { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-12345ABC' }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
        status: 201,
      });

      const result = await provider.createPayment(15.99, 'USD', 'Premium service subscription');

      expect(result).toEqual({
        paymentId: 'ORDER-12345ABC',
        paymentUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-12345ABC'
      });

      // Verify OAuth token call (1st call)
      expect(mockFetch).toHaveBeenNthCalledWith(1,
        'https://api-m.sandbox.paypal.com/v1/oauth2/token',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Authorization': 'Basic dGVzdC1jbGllbnQtaWQtMTIzNDU6dGVzdC1jbGllbnQtc2VjcmV0LTY3ODkw',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'grant_type=client_credentials'
        })
      );
    });

    it('should handle different currencies correctly', async () => {
      mockOAuthToken();
      
      const mockResponse = {
        id: 'ORDER-EUR123',
        links: [{ rel: 'approve', href: 'https://paypal.com/approve/ORDER-EUR123' }]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
        status: 201,
      });

      await provider.createPayment(25.50, 'eur', 'European payment');
      
      expect(mockFetch).toHaveBeenCalledTimes(2); // OAuth + order creation
    });

    it('should throw error when order response is invalid', async () => {
      mockOAuthToken();
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ /* missing id/links */ }),
        status: 201,
      });

      await expect(provider.createPayment(10.00, 'USD', 'Test payment'))
        .rejects.toThrow('[PayPalProvider] Invalid response from /checkout/orders (missing id/links)');
    });

    it('should throw error when no approval link found', async () => {
      mockOAuthToken();
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'ORDER-123',
          links: [{ rel: 'self', href: 'https://api.paypal.com/orders/ORDER-123' }]
        }),
        status: 201,
      });

      await expect(provider.createPayment(10.00, 'USD', 'Test payment'))
        .rejects.toThrow('[PayPalProvider] No approval link found in PayPal order response');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(provider.createPayment(10.00, 'USD', 'Test payment'))
        .rejects.toThrow('Network error');
    });

    it('should handle HTTP errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(provider.createPayment(10.00, 'USD', 'Test payment'))
        .rejects.toThrow('Token fetch failed');
    });
  });

  describe('getPaymentStatus', () => {
    it('should get payment status successfully', async () => {
      mockOAuthToken();
      
      const mockOrder = { status: 'CREATED' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockOrder,
        status: 200,
      });

      const status = await provider.getPaymentStatus('ORDER-123');
      expect(status).toBe('CREATED');
    });

    it('should handle CREATED status', async () => {
      mockOAuthToken();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'CREATED' }),
        status: 200,
      });
      
      const result = await provider.getPaymentStatus('ORDER-123');
      expect(result).toBe('CREATED');
    });
    
    it('should handle COMPLETED status', async () => {
      mockOAuthToken();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'COMPLETED' }),
        status: 200,
      });
      
      const result = await provider.getPaymentStatus('ORDER-456');
      expect(result).toBe('paid'); // PayPal COMPLETED maps to 'paid'
    });
    
    it('should handle APPROVED status with auto-capture attempt', async () => {
      mockOAuthToken(); // For initial status check
      
      // Mock initial status response (APPROVED)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'APPROVED' }),
        status: 200,
      });
      
      // Auto-capture will be attempted but fail without token, so it returns APPROVED
      const result = await provider.getPaymentStatus('ORDER-123');
      expect(result).toBe('APPROVED');
    });

    it('should return unknown for missing status', async () => {
      mockOAuthToken();
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
        status: 200,
      });

      const status = await provider.getPaymentStatus('ORDER-123');
      expect(status).toBe('unknown');
    });

    it('should handle 404 errors for non-existent orders', async () => {
      mockOAuthToken();
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      });

      await expect(provider.getPaymentStatus('ORDER-NONEXISTENT'))
        .rejects.toThrow('HTTP 404');
    });

    it('should validate paymentId parameter', async () => {
      await expect(provider.getPaymentStatus(''))
        .rejects.toThrow('[PayPalProvider] Invalid paymentId provided');
        
      await expect(provider.getPaymentStatus(null as any))
        .rejects.toThrow('[PayPalProvider] Invalid paymentId provided');
    });
  });

  describe('capturePayment', () => {
    it('should capture approved payment successfully', async () => {
      mockOAuthToken();
      
      const mockCaptureResponse = { status: 'COMPLETED' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockCaptureResponse,
        status: 201,
      });

      const status = await provider.capturePayment('ORDER-123');
      expect(status).toBe('paid'); // PayPal COMPLETED maps to 'paid'
    });

    it('should validate paymentId for capture', async () => {
      await expect(provider.capturePayment(''))
        .rejects.toThrow('[PayPalProvider] Invalid paymentId provided for capture');
    });
  });

  describe('toPayPalAmount', () => {
    it('should format amounts correctly', () => {
      expect((provider as any).toPayPalAmount(10, 'USD')).toBe('10.00');
      expect((provider as any).toPayPalAmount(10.5, 'USD')).toBe('10.50');
      expect((provider as any).toPayPalAmount(10.99, 'USD')).toBe('10.99');
    });

    it('should handle edge cases', () => {
      expect((provider as any).toPayPalAmount(0, 'USD')).toBe('0.00');
      expect((provider as any).toPayPalAmount(0.01, 'USD')).toBe('0.01');
      expect((provider as any).toPayPalAmount(999.99, 'USD')).toBe('999.99');
    });
  });

  describe('error handling', () => {
    it('should propagate fetch errors with proper logging', async () => {
      const networkError = new Error('Connection timeout');
      mockFetch.mockRejectedValueOnce(networkError);

      await expect(provider.createPayment(10.00, 'USD', 'Test payment'))
        .rejects.toThrow('Connection timeout');
    });

    it('should handle malformed JSON responses', async () => {
      mockOAuthToken();
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => { throw new Error('Invalid JSON'); },
        status: 200,
      });

      const status = await provider.getPaymentStatus('ORDER-123');
      expect(status).toBe('unknown');
    });
  });

  describe('input validation', () => {
    it('should validate createPayment parameters', async () => {
      await expect(provider.createPayment(0, 'USD', 'Test'))
        .rejects.toThrow('[PayPalProvider] Invalid amount provided');
        
      await expect(provider.createPayment(10, '', 'Test'))
        .rejects.toThrow('[PayPalProvider] Invalid currency provided');
        
      await expect(provider.createPayment(10, 'USD', ''))
        .rejects.toThrow('[PayPalProvider] Invalid description provided');
    });
  });
});