import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker, CircuitState, GITHUB_CIRCUIT_BREAKER_CONFIG } from '../../src/utils/circuitBreaker';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;
  let mockFunction: ReturnType<typeof vi.fn>;
  let mockFallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Use a custom config for faster testing
    const testConfig = {
      failureThreshold: 3,
      recoveryTimeout: 100, // Short timeout for tests
      monitoringWindow: 60000,
    };
    circuitBreaker = new CircuitBreaker(testConfig);
    mockFunction = vi.fn();
    mockFallback = vi.fn();
  });

  describe('Circuit States', () => {
    it('should start in CLOSED state', () => {
      const status = circuitBreaker.getStatus();
      expect(status.state).toBe(CircuitState.CLOSED);
      expect(status.failureCount).toBe(0);
    });

    it('should remain CLOSED on successful calls', async () => {
      mockFunction.mockResolvedValue('success');

      const result = await circuitBreaker.execute(mockFunction);

      expect(result).toBe('success');
      expect(circuitBreaker.getStatus().state).toBe(CircuitState.CLOSED);
      expect(circuitBreaker.getStatus().failureCount).toBe(0);
    });

    it('should transition to OPEN after reaching failure threshold', async () => {
      mockFunction.mockRejectedValue(new Error('API failure'));

      // First two failures should keep circuit CLOSED
      await expect(circuitBreaker.execute(mockFunction)).rejects.toThrow('API failure');
      expect(circuitBreaker.getStatus().state).toBe(CircuitState.CLOSED);
      expect(circuitBreaker.getStatus().failureCount).toBe(1);

      await expect(circuitBreaker.execute(mockFunction)).rejects.toThrow('API failure');
      expect(circuitBreaker.getStatus().state).toBe(CircuitState.CLOSED);
      expect(circuitBreaker.getStatus().failureCount).toBe(2);

      // Third failure should OPEN the circuit
      await expect(circuitBreaker.execute(mockFunction)).rejects.toThrow('API failure');
      expect(circuitBreaker.getStatus().state).toBe(CircuitState.OPEN);
      expect(circuitBreaker.getStatus().failureCount).toBe(3);
    });
  });

  describe('OPEN State Behavior', () => {
    beforeEach(async () => {
      // Force circuit to OPEN state
      mockFunction.mockRejectedValue(new Error('API failure'));
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(mockFunction);
        } catch (e) {
          // Expected failures
        }
      }
      expect(circuitBreaker.getStatus().state).toBe(CircuitState.OPEN);
    });

    it('should fail fast when circuit is OPEN without fallback', async () => {
      await expect(circuitBreaker.execute(mockFunction)).rejects.toThrow(
        'Circuit breaker is OPEN - service unavailable'
      );

      // Function should not be called when circuit is open
      expect(mockFunction).toHaveBeenCalledTimes(3); // Only the initial failures
    });

    it('should use fallback when circuit is OPEN', async () => {
      mockFallback.mockResolvedValue('fallback result');

      const result = await circuitBreaker.execute(mockFunction, mockFallback);

      expect(result).toBe('fallback result');
      expect(mockFallback).toHaveBeenCalledTimes(1);
      expect(mockFunction).toHaveBeenCalledTimes(3); // Only the initial failures
    });

    it('should transition to HALF_OPEN after recovery timeout', async () => {
      // Wait for recovery timeout
      await new Promise(resolve => setTimeout(resolve, 150));

      mockFunction.mockResolvedValue('recovery success');

      const result = await circuitBreaker.execute(mockFunction);

      expect(result).toBe('recovery success');
      expect(circuitBreaker.getStatus().state).toBe(CircuitState.CLOSED);
    });

    it('should go back to OPEN if HALF_OPEN test fails', async () => {
      // Wait for recovery timeout
      await new Promise(resolve => setTimeout(resolve, 150));

      // Mock function still fails during recovery test
      mockFunction.mockRejectedValue(new Error('Still failing'));
      mockFallback.mockResolvedValue('fallback during recovery');

      const result = await circuitBreaker.execute(mockFunction, mockFallback);

      expect(result).toBe('fallback during recovery');
      expect(circuitBreaker.getStatus().state).toBe(CircuitState.OPEN);
    });
  });

  describe('Success Recovery', () => {
    it('should reset failure count on successful call', async () => {
      mockFunction
        .mockRejectedValueOnce(new Error('failure 1'))
        .mockRejectedValueOnce(new Error('failure 2'))
        .mockResolvedValue('success');

      // Two failures
      await expect(circuitBreaker.execute(mockFunction)).rejects.toThrow('failure 1');
      await expect(circuitBreaker.execute(mockFunction)).rejects.toThrow('failure 2');
      expect(circuitBreaker.getStatus().failureCount).toBe(2);

      // Success should reset failure count
      const result = await circuitBreaker.execute(mockFunction);
      expect(result).toBe('success');
      expect(circuitBreaker.getStatus().failureCount).toBe(0);
      expect(circuitBreaker.getStatus().state).toBe(CircuitState.CLOSED);
    });
  });

  describe('Manual Reset', () => {
    it('should reset circuit breaker to initial state', async () => {
      // Force circuit to OPEN
      mockFunction.mockRejectedValue(new Error('API failure'));
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(mockFunction);
        } catch (e) {
          // Expected failures
        }
      }

      expect(circuitBreaker.getStatus().state).toBe(CircuitState.OPEN);
      expect(circuitBreaker.getStatus().failureCount).toBe(3);

      // Manual reset
      circuitBreaker.reset();

      const status = circuitBreaker.getStatus();
      expect(status.state).toBe(CircuitState.CLOSED);
      expect(status.failureCount).toBe(0);
      expect(status.lastFailureTime).toBe(0);
    });
  });

  describe('Error Propagation', () => {
    it('should propagate original error when circuit is CLOSED', async () => {
      const customError = new Error('Custom API error');
      mockFunction.mockRejectedValue(customError);

      await expect(circuitBreaker.execute(mockFunction)).rejects.toThrow('Custom API error');
    });

    it('should propagate fallback errors when fallback fails', async () => {
      // Force circuit to OPEN
      mockFunction.mockRejectedValue(new Error('API failure'));
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(mockFunction);
        } catch (e) {
          // Expected failures
        }
      }

      const fallbackError = new Error('Fallback failed');
      mockFallback.mockRejectedValue(fallbackError);

      await expect(circuitBreaker.execute(mockFunction, mockFallback)).rejects.toThrow(
        'Fallback failed'
      );
    });
  });

  describe('Default Configuration', () => {
    it('should use sensible defaults for GitHub API', () => {
      const defaultBreaker = new CircuitBreaker(GITHUB_CIRCUIT_BREAKER_CONFIG);

      expect(GITHUB_CIRCUIT_BREAKER_CONFIG.failureThreshold).toBe(3);
      expect(GITHUB_CIRCUIT_BREAKER_CONFIG.recoveryTimeout).toBe(30000); // 30 seconds
      expect(GITHUB_CIRCUIT_BREAKER_CONFIG.monitoringWindow).toBe(60000); // 1 minute

      expect(defaultBreaker.getStatus().state).toBe(CircuitState.CLOSED);
    });
  });

  describe('Concurrent Calls', () => {
    it('should handle concurrent calls correctly', async () => {
      mockFunction.mockRejectedValue(new Error('API failure'));

      // Make 5 concurrent calls that will fail
      const promises = Array(5).fill(null).map(() =>
        circuitBreaker.execute(mockFunction).catch(e => e)
      );

      const results = await Promise.all(promises);

      // All calls should result in errors
      results.forEach(result => {
        expect(result).toBeInstanceOf(Error);
      });

      // Circuit should be open after threshold is reached
      expect(circuitBreaker.getStatus().state).toBe(CircuitState.OPEN);
    });
  });

  describe('Timing Edge Cases', () => {
    it('should handle rapid state transitions correctly', async () => {
      const testConfig = {
        failureThreshold: 2,
        recoveryTimeout: 50,
        monitoringWindow: 60000,
      };
      const rapidBreaker = new CircuitBreaker(testConfig);

      // Rapid failures to open circuit
      mockFunction.mockRejectedValue(new Error('failure'));
      await expect(rapidBreaker.execute(mockFunction)).rejects.toThrow();
      await expect(rapidBreaker.execute(mockFunction)).rejects.toThrow();

      expect(rapidBreaker.getStatus().state).toBe(CircuitState.OPEN);

      // Wait for recovery and test transition
      await new Promise(resolve => setTimeout(resolve, 60));
      mockFunction.mockResolvedValue('success');

      const result = await rapidBreaker.execute(mockFunction);
      expect(result).toBe('success');
      expect(rapidBreaker.getStatus().state).toBe(CircuitState.CLOSED);
    });
  });
});