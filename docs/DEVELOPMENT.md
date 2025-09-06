# Development Setup

Complete guide for setting up PayMCP for local development and testing.

## Quick Start

1. **Clone and install dependencies**:
   ```bash
   git clone <repo>
   cd paymcp-ts
   pnpm install
   ```

2. **Build the project**:
   ```bash
   pnpm run build
   ```

3. **Set up environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your API keys
   ```

4. **Run tests**:
   ```bash
   pnpm test
   ```

## Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm run build` | Build the library for distribution |
| `pnpm run test` | Run all tests once |
| `pnpm run test:watch` | Run tests in watch mode |
| `pnpm run lint` | Lint the codebase |
| `pnpm run type-check` | Type check without emitting |

## API Keys Setup

### PayPal Sandbox

1. Go to [PayPal Developer Dashboard](https://developer.paypal.com/developer/applications/)
2. Log in with your PayPal account
3. Click "Create App" 
4. Choose "Sandbox" environment
5. Select "Default Application" or create new
6. Copy the **Client ID** and **Client Secret**
7. Set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in your `.env`

**Note**: PayPal sandbox uses `https://api-m.sandbox.paypal.com/v2` (already configured)

### Stripe Test Mode

1. Go to [Stripe Dashboard](https://dashboard.stripe.com/test/apikeys)
2. Toggle to "Test mode" (top right)
3. Copy your **Secret key** (starts with `sk_test_`)
4. Set `STRIPE_SECRET_KEY` in your `.env`

**Note**: Test mode is safe for development and won't charge real money.

### Walleot

1. Contact Walleot for API access
2. Get your API key from the dashboard
3. Set `WALLEOT_API_KEY` in your `.env`

## Live Testing

For testing with real PayPal API:

```bash
# Set up your .env with PayPal credentials
cp .env.example .env

# Run live PayPal testing
pnpm tsx tests/paypal/paypal-live-tools.ts demo
```

The live testing tools provide interactive commands:
- `demo` - Create payment and get approval URL
- `status <payment_id>` - Check payment status
- `capture <payment_id>` - Manually capture payment
- `manual` - Interactive testing workflow

## Testing

### Unit Tests

```bash
pnpm run test        # Run all tests
pnpm run test:watch  # Watch mode
```

Tests are in `tests/` directory using Vitest framework.

### Manual Testing

Use the live testing tools to verify PayPal integration:

```bash
# Create payment and get approval URL
pnpm tsx tests/paypal/paypal-live-tools.ts demo

# Check payment status  
pnpm tsx tests/paypal/paypal-live-tools.ts status PAYMENT_ID

# Interactive testing
pnpm tsx tests/paypal/paypal-live-tools.ts manual
```


## Project Structure

```
paymcp-ts/
├── src/                    # Main library code
│   ├── providers/          # Payment providers
│   │   ├── stripe.ts
│   │   ├── walleot.ts  
│   │   ├── paypal.ts       # PayPal provider
│   │   └── index.ts        # Provider exports
│   ├── flows/              # Payment flows
│   ├── types/              # TypeScript types
│   └── index.ts            # Main exports
├── tests/                  # Test suite
│   ├── providers/          # Unit tests
│   ├── paypal/            # PayPal integration and live tests
│   └── utils/             # Test utilities
├── docs/                  # Documentation
├── dist/                  # Built library (generated)
└── README.md              # Main documentation
```

## Provider Development

To add new providers:

1. Create new file in `src/providers/`
2. Extend `BasePaymentProvider` 
3. Implement `createPayment()` and `getPaymentStatus()`
4. Add to `src/providers/index.ts` registry
5. Add tests in `tests/providers/`

See existing providers as examples.

## Troubleshooting

### Common Issues

1. **"Unknown provider" error**: Check provider is registered in `src/providers/index.ts`
2. **API authentication errors**: Verify API keys are correct and have proper permissions
3. **TypeScript errors**: Run `pnpm run type-check` to see detailed errors
4. **Build issues**: Clear `dist/` and rebuild: `rm -rf dist && pnpm run build`

### Debug Mode

Enable verbose logging:

```ts
installPayMCP(server, {
  // ... other config
  logger: console, // Use console for debug output
});
```

### Testing Payment Webhooks

For production, you'll need webhook endpoints to handle payment confirmations. The development server uses polling instead for simplicity.