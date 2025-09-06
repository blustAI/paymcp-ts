# PayPal Provider Tests

Test suite for the PayPal payment provider integration with PayMCP.

## Test Structure

```
tests/
├── providers/          # Unit tests for provider implementations
│   └── paypal.test.ts  # PayPal provider unit tests (22 tests)
├── paypal/            # PayPal-specific integration and live tests
│   ├── paypal-comprehensive.test.ts  # Integration tests (9 tests)
│   └── paypal-live-tools.ts         # Live PayPal API testing tools
├── utils/             # Test utilities and helpers
│   ├── paypal-mocks.ts
│   └── mcp-test-helpers.ts
└── setup.ts           # Global test setup
```

## Test Categories

### 1. Unit Tests (`tests/providers/paypal.test.ts`)
- **22 comprehensive tests**
- **Focus**: PayPal provider class methods in isolation
- **Coverage**: 
  - Constructor and configuration with OAuth credentials
  - OAuth token management and refresh
  - Payment creation with auto-capture
  - Status checking and mapping (COMPLETED → paid)
  - Amount formatting and validation
  - Error handling and network failures
  - Input validation for all methods

### 2. Integration Tests (`tests/paypal/paypal-comprehensive.test.ts`)
- **9 integration tests**
- **Focus**: PayPal provider integration with PayMCP and MCP protocol
- **Coverage**:
  - PayMCP system integration
  - MCP tool registration and execution
  - Payment flow testing (TWO_STEP, ELICITATION)
  - Error handling (auth failures, rate limiting)
  - Multi-currency support (USD, EUR, GBP)
  - Edge cases (minimum/maximum payments)

### 3. Live Testing Tools (`tests/paypal/paypal-live-tools.ts`)
- **Interactive PayPal API testing**
- **Focus**: Real PayPal sandbox validation
- **Features**:
  - Live payment creation with real PayPal orders
  - Payment status monitoring and auto-capture
  - Manual approval workflow testing
  - Direct API validation without mocks

## Test Utilities

### PayPal Mocks (`tests/utils/paypal-mocks.ts`)
- `PayPalMockFactory` - Creates realistic PayPal API responses
- `MockLoggerFactory` - Creates logger mocks with capture capabilities
- `TestDataFactory` - Generates test scenarios and data

### MCP Helpers (`tests/utils/mcp-test-helpers.ts`)
- `MCPTestHelpers` - Utilities for MCP server testing
- `PayPalMCPAssertions` - Specialized assertions for PayPal MCP integration

## Running Tests

### All Tests
```bash
pnpm test
```

### Watch Mode
```bash
pnpm run test:watch
```

### Specific Test Categories
```bash
# Unit tests only
pnpm test tests/providers/

# Integration tests only  
pnpm test tests/paypal/paypal-comprehensive.test.ts

# Live PayPal testing (requires .env)
pnpm tsx tests/paypal/paypal-live-tools.ts demo
```

### With Coverage
```bash
pnpm test --coverage
```

## Testing Without External Dependencies

All tests use mocked PayPal API responses and don't require:
- Actual PayPal sandbox credentials
- Network connectivity
- Claude Desktop or external MCP clients
- Live payment processing

### Standalone MCP Client Testing

The `mcp-standalone-client.test.ts` demonstrates how to test MCP servers independently:

```typescript
import { MCPTestHelpers } from '../utils/mcp-test-helpers.js';

// Create test server
const testServer = MCPTestHelpers.createTestServer();

// Test MCP protocol directly
const response = await MCPTestHelpers.callTool(
  testServer.requestHandler,
  'paid_tool',
  { arg: 'value' }
);
```

## Mock Scenarios

### Common Payment Flows
- Successful payment creation and completion
- Payment cancellation by user
- Authentication failures
- Network timeouts
- Rate limiting

### PayPal API Responses
- Order creation responses
- Order status responses (all statuses)
- Error responses (401, 422, 404, 429, 503)
- Malformed responses

### MCP Protocol Scenarios
- Tool registration and listing
- Payment initiation through tools
- Payment confirmation flows
- Error propagation through MCP

## Test Configuration

### Setup (`tests/setup.ts`)
- Global fetch mocking
- Console noise reduction
- Mock cleanup between tests

### Vitest Config (`vitest.config.ts`)
- Test file patterns
- Coverage configuration
- Test timeouts for integration tests
- Global setup files

## Best Practices

1. Use descriptive test names that explain the scenario
2. Group related tests with `describe` blocks
3. Mock at the right level - network for unit tests, responses for integration
4. Verify both success and error paths
5. Test edge cases (min/max amounts, special characters, etc.)
6. Use test utilities to reduce duplication
7. Assert meaningful outcomes not just absence of errors

## Debugging Tests

### Enable Debug Logging
```typescript
const testServer = MCPTestHelpers.createTestServer({
  // Use real console for debugging
  logger: console
});
```

### Inspect Mock Calls
```typescript
// Check what was called
expect(mockFetch).toHaveBeenCalledWith(/* expected args */);

// Inspect all calls
console.log(mockFetch.mock.calls);
```

### Capture Logs
```typescript
const logger = MockLoggerFactory.createWithCapture();
// ... run test ...
console.log(logger.getLogs());
```

## Adding New Tests

### For New PayPal Features
1. Add unit tests in `paypal.test.ts`
2. Add integration scenarios in `paypal-integration.test.ts` 
3. Add MCP-specific tests in `paypal-mcp.test.ts`
4. Add end-to-end workflows in `paypal-e2e.test.ts`

### For New Mock Scenarios
1. Add to `PayPalMockFactory` in `paypal-mocks.ts`
2. Create reusable test data in `TestDataFactory`
3. Add helper assertions in `PayPalMCPAssertions`

This comprehensive test suite ensures the PayPal provider works correctly at all integration levels without requiring external dependencies or services.