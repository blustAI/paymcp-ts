// Global test setup
import { vi, beforeEach, afterEach } from 'vitest';

// Mock global fetch for all tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock console methods by default to reduce test noise
global.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Global test hooks
beforeEach(() => {
  // Clear all mocks before each test
  vi.clearAllMocks();
});

afterEach(() => {
  // Restore all mocks after each test
  vi.restoreAllMocks();
});

// Add common test utilities to global scope
declare global {
  var mockFetch: typeof mockFetch;
}

global.mockFetch = mockFetch;