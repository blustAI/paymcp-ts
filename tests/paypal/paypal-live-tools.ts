#!/usr/bin/env node

/**
 * PayPal Live Testing Tools
 * 
 * Collection of utilities for live PayPal testing with real credentials.
 * Includes payment creation, status checking, auto-capture, and manual approval flows.
 * 
 * Usage:
 *   pnpm tsx tests/paypal/paypal-live-tools.ts demo       - Demo auto-capture flow
 *   pnpm tsx tests/paypal/paypal-live-tools.ts status ID  - Check payment status
 *   pnpm tsx tests/paypal/paypal-live-tools.ts capture ID - Capture specific payment
 *   pnpm tsx tests/paypal/paypal-live-tools.ts manual     - Manual approval flow
 * 
 * Prerequisites: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { installPayMCP, PaymentFlow } from '../../src/index.js';
import { PayPalProvider } from '../../src/providers/paypal.js';

// Load environment variables
try {
  const { config } = await import('dotenv');
  config();
} catch {
  console.log('⚠️  No dotenv found, using system environment');
}

const hasCredentials = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

if (!hasCredentials) {
  console.log('❌ Missing PayPal credentials in .env file');
  console.log('Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to test live payments');
  process.exit(1);
}

const command = process.argv[2] || 'help';
const paymentId = process.argv[3];

// Helper to create PayPal provider
function createProvider() {
  return new PayPalProvider({
    clientId: process.env.PAYPAL_CLIENT_ID!,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
    successUrl: 'https://example.com/success',
    cancelUrl: 'https://example.com/cancel',
    logger: console,
  });
}

// Helper to create MCP server with PayPal
function createMCPServer() {
  const server = new Server({ name: "live-test", version: "1.0.0" });
  
  // Add registerTool method for PayMCP compatibility
  (server as any).registerTool = (name: string, config: any, handler: any) => {
    if (!(server as any).tools) {
      (server as any).tools = new Map();
    }
    (server as any).tools.set(name, { config, handler });
  };

  // Install PayMCP
  installPayMCP(server as any, {
    providers: {
      paypal: {
        clientId: process.env.PAYPAL_CLIENT_ID!,
        clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      },
    },
    paymentFlow: PaymentFlow.TWO_STEP,
    logger: console,
  });

  return server;
}

// Demo: Auto-capture flow
async function runDemo() {
  console.log('🚀 PayPal Auto-Capture Demo\n');
  
  const provider = createProvider();

  try {
    console.log('📋 Step 1: Creating PayPal payment...');
    const { paymentId, paymentUrl } = await provider.createPayment(
      1.25, 
      'USD', 
      'Auto-capture demo payment'
    );

    console.log('✅ Payment created successfully!');
    console.log(`🆔 Payment ID: ${paymentId}`);
    console.log(`🔗 Approval URL: ${paymentUrl}`);
    console.log('');

    console.log('📋 Step 2: Initial status check...');
    const initialStatus = await provider.getPaymentStatus(paymentId);
    console.log(`📊 Initial Status: ${initialStatus}`);
    console.log('');

    console.log('🔄 Next Steps:');
    console.log('1. Open the approval URL in your browser');
    console.log('2. Complete PayPal payment approval');
    console.log('3. Run status check to see auto-capture:');
    console.log(`   pnpm tsx tests/paypal/paypal-live-tools.ts status ${paymentId}`);
    console.log('');
    console.log('Expected flow:');
    console.log('• Before approval: CREATED → CREATED');  
    console.log('• After approval: APPROVED → auto-capture → COMPLETED');

  } catch (error: any) {
    console.log('❌ Demo failed:', error.message);
  }
}

// Check payment status (with auto-capture)
async function checkStatus(paymentId: string) {
  console.log(`🔍 Checking PayPal payment status: ${paymentId}\n`);
  
  const provider = createProvider();

  try {
    const status = await provider.getPaymentStatus(paymentId);
    
    console.log('📊 Payment Status Result:');
    console.log(`   Payment ID: ${paymentId}`);
    console.log(`   Status: ${status}`);
    console.log('');

    switch (status.toUpperCase()) {
      case 'COMPLETED':
        console.log('✅ SUCCESS: Payment has been captured and completed!');
        break;
      case 'APPROVED':
        console.log('✅ APPROVED: Payment approved and ready to capture');
        console.log('   (Auto-capture may have failed - try again)');
        break;
      case 'CREATED':
        console.log('⏳ PENDING: Payment created, awaiting approval');
        break;
      case 'CANCELLED':
        console.log('❌ CANCELLED: Payment was cancelled');
        break;
      default:
        console.log(`ℹ️  Status: ${status}`);
    }

  } catch (error: any) {
    console.log('❌ Error checking payment status:', error.message);
  }
}

// Capture specific payment
async function capturePayment(paymentId: string) {
  console.log(`🔄 Capturing payment: ${paymentId}\n`);
  
  const provider = createProvider();

  try {
    const result = await provider.capturePayment(paymentId);
    console.log('✅ Payment Capture Result:');
    console.log(`   Payment ID: ${paymentId}`);
    console.log(`   Status: ${result}`);
    
    if (result === 'COMPLETED') {
      console.log('🎉 SUCCESS: Payment captured successfully!');
    }

  } catch (error: any) {
    console.log('❌ Error during capture:', error.message);
  }
}

// Manual approval flow with MCP
async function runManualFlow() {
  console.log('🚀 PayPal Manual Approval Flow (MCP Level)\n');
  
  const server = createMCPServer();

  // Register test tool
  (server as any).registerTool(
    "live_test_tool",
    {
      title: "Live Test Tool",
      description: "Test tool for manual PayPal approval flow",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      price: { amount: 0.75, currency: "USD" },
    },
    async ({ message }) => {
      return {
        content: [{ type: "text", text: `Test completed: ${message}` }],
      };
    }
  );

  // Mock client to call tools
  const mcpClient = {
    async callTool(name: string, args: any) {
      const toolsMap = (server as any).tools;
      if (!toolsMap || !toolsMap.has(name)) {
        throw new Error(`Tool not found: ${name}`);
      }
      const tool = toolsMap.get(name);
      return await tool.handler(args, {});
    }
  };

  try {
    console.log('📋 Step 1: Calling paid MCP tool...\n');

    // Call the paid tool (creates PayPal order)
    const result = await mcpClient.callTool('live_test_tool', { 
      message: 'Hello from MCP live test!' 
    });

    const responseText = result.content[0].text;
    console.log('💳 MCP Payment Response:');
    console.log(responseText);
    console.log('');

    // Extract payment details
    const paymentUrlMatch = responseText.match(/payment_url["\s:]+([^"\s,}]+)/);
    const paymentIdMatch = responseText.match(/payment_id["\s:]+([^"\s,}]+)/);

    if (!paymentUrlMatch || !paymentIdMatch) {
      console.log('❌ Could not extract payment details from response');
      return;
    }

    const paymentUrl = paymentUrlMatch[1];
    const paymentId = paymentIdMatch[1];

    console.log('🔗 PayPal Approval URL:');
    console.log(`   ${paymentUrl}`);
    console.log('');
    console.log('🆔 Payment ID:', paymentId);
    console.log('');
    
    console.log('📋 Step 2: Manual Approval Instructions');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('1. 🌐 Open the URL above in your browser');
    console.log('2. 💳 Complete PayPal payment approval');
    console.log('3. 🔄 Check status with auto-capture:');
    console.log(`   pnpm tsx tests/paypal/paypal-live-tools.ts status ${paymentId}`);
    console.log('4. 🎯 Or test confirmation tool:');
    console.log(`   # This should return "Test completed: Hello from MCP live test!"`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  } catch (error: any) {
    console.log('❌ Error during manual flow:', error.message);
  }
}

// Help/usage information
function showHelp() {
  console.log('PayPal Live Testing Tools\n');
  console.log('Usage:');
  console.log('  pnpm tsx tests/paypal/paypal-live-tools.ts <command> [payment-id]\n');
  console.log('Commands:');
  console.log('  demo              - Demo auto-capture flow');
  console.log('  status <id>       - Check payment status (with auto-capture)');
  console.log('  capture <id>      - Manually capture specific payment');
  console.log('  manual            - Manual approval flow with MCP tools');
  console.log('  help              - Show this help message\n');
  console.log('Examples:');
  console.log('  pnpm tsx tests/paypal/paypal-live-tools.ts demo');
  console.log('  pnpm tsx tests/paypal/paypal-live-tools.ts status ORDER-123ABC');
  console.log('  pnpm tsx tests/paypal/paypal-live-tools.ts manual\n');
  console.log('Prerequisites:');
  console.log('  - PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env file');
  console.log('  - PayPal sandbox account for testing');
}

// Main execution
async function main() {
  console.log('🧪 PayPal Live Testing Tools\n');

  switch (command) {
    case 'demo':
      await runDemo();
      break;
    case 'status':
      if (!paymentId) {
        console.log('❌ Payment ID required for status command');
        console.log('Usage: pnpm tsx tests/paypal/paypal-live-tools.ts status PAYMENT_ID');
        process.exit(1);
      }
      await checkStatus(paymentId);
      break;
    case 'capture':
      if (!paymentId) {
        console.log('❌ Payment ID required for capture command');
        console.log('Usage: pnpm tsx tests/paypal/paypal-live-tools.ts capture PAYMENT_ID');
        process.exit(1);
      }
      await capturePayment(paymentId);
      break;
    case 'manual':
      await runManualFlow();
      break;
    case 'help':
    default:
      showHelp();
      break;
  }

  console.log('\n🏁 Tool completed');
}

main().catch(console.error);