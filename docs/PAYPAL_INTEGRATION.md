# PayPal Integration Guide

How to integrate PayPal payments with PayMCP.

## Overview

The PayPal provider uses PayPal's Payments API v2 with automatic token management. It works with sandbox and production environments, supports multiple currencies, and handles all PayMCP payment flows.

## Features

- PayPal Payments API v2 integration
- Automatic token management with client credentials
- Multi-currency support (USD, EUR, etc.)
- Sandbox and production environments
- All payment flows: TWO_STEP, ELICITATION, PROGRESS
- Error handling and token refresh

## Quick Start

### 1. Get PayPal Sandbox Credentials

1. Go to [PayPal Developer Dashboard](https://developer.paypal.com/developer/applications/)
2. Create a new app in **Sandbox** mode
3. Copy the **Client ID** and **Client Secret**

### 2. Configure PayMCP

```typescript
import { installPayMCP, PaymentFlow } from "paymcp";

installPayMCP(server, {
  providers: {
    paypal: {
      clientId: process.env.PAYPAL_CLIENT_ID,
      clientSecret: process.env.PAYPAL_CLIENT_SECRET,
      successUrl: "https://yourapp.com/success?order_id={token}",
      cancelUrl: "https://yourapp.com/cancel",
    },
  },
  paymentFlow: PaymentFlow.TWO_STEP,
  logger: console,
});
```

### 3. Register Paid Tools

```typescript
server.registerTool(
  "premium_analysis",
  {
    title: "Premium Data Analysis",
    description: "AI-powered analysis with PayPal payments",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
      },
      required: ["dataset"],
    },
    price: { amount: 5.99, currency: "USD" },
  },
  async ({ dataset }) => {
    return {
      content: [{ 
        type: "text", 
        text: `Analysis complete for ${dataset}` 
      }],
    };
  }
);
```

## Configuration Options

### PayPal Provider Options

```typescript
interface PayPalProviderOpts {
  // Authentication (choose one)
  apiKey?: string;              // Direct access token (legacy)
  clientId?: string;            // Client ID (recommended)
  clientSecret?: string;        // Client secret (recommended)
  
  // URLs
  successUrl?: string;          // Success redirect URL
  cancelUrl?: string;           // Cancel redirect URL
  logger?: Logger;              // Custom logger
}
```

### Environment Variables

```bash
# PayPal Sandbox
PAYPAL_CLIENT_ID=your_client_id_here
PAYPAL_CLIENT_SECRET=your_client_secret_here

# PayPal Production (when ready)
PAYPAL_CLIENT_ID=production_client_id
PAYPAL_CLIENT_SECRET=production_client_secret
```

## Payment Flows

### TWO_STEP Flow (Default)

```typescript
paymentFlow: PaymentFlow.TWO_STEP
```

1. User calls paid tool → Returns PayPal order URL
2. User completes PayPal payment
3. User calls confirmation tool → Executes original logic

### ELICITATION Flow

```typescript
paymentFlow: PaymentFlow.ELICITATION
```

Uses MCP elicitation to prompt user for payment inline.

### PROGRESS Flow

```typescript
paymentFlow: PaymentFlow.PROGRESS
```

Streams progress updates while polling PayPal for payment completion.

## Multi-Currency Support

```typescript
// USD pricing
price: { amount: 9.99, currency: "USD" }

// Euro pricing
price: { amount: 8.50, currency: "EUR" }

// British pounds
price: { amount: 7.99, currency: "GBP" }
```

PayPal automatically handles currency conversion and local payment methods.

## Error Handling

The PayPal provider handles various error scenarios:

### Common Error Types

- **Authentication errors**: Invalid client credentials
- **Network errors**: Connectivity issues
- **Rate limiting**: Too many requests
- **Invalid orders**: Malformed payment requests
- **Token expiration**: Automatic token refresh

### Error Responses

```typescript
try {
  const result = await provider.createPayment(10.00, "USD", "Test payment");
} catch (error) {
  if (error.message.includes("HTTP 401")) {
    // Authentication error - check credentials
  } else if (error.message.includes("HTTP 429")) {
    // Rate limited - implement backoff
  } else {
    // Other error
  }
}
```

## Production Deployment

### 1. Switch to Production Credentials

```bash
# Production environment variables
PAYPAL_CLIENT_ID=production_client_id_here
PAYPAL_CLIENT_SECRET=production_client_secret_here
```

### 2. Update Base URL

The provider automatically uses:
- **Sandbox**: `https://api-m.sandbox.paypal.com/v2`
- **Production**: `https://api-m.paypal.com/v2` (when using production credentials)

### 3. Configure Real URLs

```typescript
paypal: {
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  successUrl: "https://yourproductionapp.com/payment/success",
  cancelUrl: "https://yourproductionapp.com/payment/cancel",
}
```

## Testing

### Unit Tests

```bash
# Test PayPal provider in isolation
pnpm test tests/providers/paypal.test.ts
```

### Integration Tests

```bash
# Test PayPal with PayMCP system
pnpm test tests/integration/paypal-integration.test.ts
```

### Live Sandbox Testing

```bash
# Test against real PayPal sandbox
pnpm test tests/e2e/paypal-e2e.test.ts
```

### Development Server

```bash
# Run full demo server
cd examples/dev-server
pnpm run dev
```

## Advanced Features

### Custom Success/Cancel URLs

```typescript
paypal: {
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  successUrl: "https://yourapp.com/success?order_id={token}&session={session_id}",
  cancelUrl: "https://yourapp.com/cancel?reason=user_cancelled",
}
```

### Custom Logging

```typescript
const customLogger = {
  debug: (msg: string, ...args: any[]) => console.log(`[DEBUG] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${msg}`, ...args),
  info: (msg: string, ...args: any[]) => console.info(`[INFO] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${msg}`, ...args),
};

paypal: {
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  logger: customLogger,
}
```

### Multiple Providers with Fallback

```typescript
installPayMCP(server, {
  providers: {
    // Primary
    paypal: {
      clientId: process.env.PAYPAL_CLIENT_ID,
      clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    },
    // Fallback
    stripe: {
      apiKey: process.env.STRIPE_SECRET_KEY,
    },
  },
});
```

## Troubleshooting

### Common Issues

**"Authentication failed"**
- Check `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`
- Make sure credentials match your environment (sandbox vs production)
- Verify your app is active in PayPal Developer Dashboard

**"Invalid request" errors**
- Use uppercase currency codes: "USD", "EUR"
- Use numbers for amounts, not strings
- Make sure all required fields are provided

**"Network timeout" errors**
- Check your internet connection
- Verify PayPal API endpoints are reachable
- Consider adding retry logic

**"Token refresh failed"**
- Your client credentials might be invalid
- Check if your PayPal app is active
- Verify app permissions in PayPal dashboard

### Debug Mode

Enable verbose logging:

```typescript
paypal: {
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  logger: console, // Enables debug logging
}
```

### API Rate Limits

PayPal has rate limits:
- **Sandbox**: 50 requests per second
- **Production**: Varies by agreement

Implement exponential backoff for rate limit errors (HTTP 429).

## Migration Guide

### From Access Tokens to Client Credentials

If you're currently using direct access tokens:

```typescript
// Old approach (deprecated)
paypal: {
  apiKey: "access_token_here", // Expires frequently
}

// New approach (recommended)
paypal: {
  clientId: process.env.PAYPAL_CLIENT_ID,     // Long-lived
  clientSecret: process.env.PAYPAL_CLIENT_SECRET, // Long-lived
}
```

Benefits of client credentials:
- No manual token refresh needed
- Production-ready
- Automatic error handling
- Better security practices

## Resources

- [PayPal Developer Documentation](https://developer.paypal.com/docs/api/payments/v2/)
- [PayPal Sandbox Testing](https://developer.paypal.com/developer/accounts/)
- [PayPal API Reference](https://developer.paypal.com/docs/api/payments/v2/)
- [PayMCP Documentation](../README.md)
- [Testing Guide](./TESTING.md)

## Support

For PayPal-specific issues:
- Check [PayPal Developer Community](https://developer.paypal.com/community/)
- Review [PayPal API Status](https://www.paypal-status.com/)

For PayMCP integration issues:
- See [Development Guide](./DEVELOPMENT.md)
- Check [Testing Documentation](./TESTING.md)