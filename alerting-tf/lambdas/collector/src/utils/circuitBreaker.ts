/**
 * Circuit Breaker pattern implementation for GitHub API reliability
 *
 * Prevents cascading failures when GitHub API is down by:
 * - Tracking failure rates
 * - Opening circuit when failure threshold is reached
 * - Providing fallback behavior during outages
 * - Auto-recovery with half-open state testing
 */

export interface CircuitBreakerConfig {
  failureThreshold: number;     // Number of failures before opening
  recoveryTimeout: number;      // Time in ms before attempting recovery
  monitoringWindow: number;     // Time window for failure tracking
}

export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Circuit is open, failing fast
  HALF_OPEN = 'HALF_OPEN' // Testing recovery
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private nextAttemptTime: number = 0;

  constructor(private config: CircuitBreakerConfig) {}

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttemptTime) {
        // Circuit is still open, use fallback or throw
        if (fallback) {
          console.log('Circuit breaker OPEN - using fallback');
          return await fallback();
        } else {
          throw new Error('Circuit breaker is OPEN - service unavailable');
        }
      } else {
        // Time to test recovery
        this.state = CircuitState.HALF_OPEN;
        console.log('Circuit breaker transitioning to HALF_OPEN for recovery test');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();

      // If circuit is now open and we have a fallback, use it
      if (this.state === CircuitState.OPEN && fallback) {
        console.log('Circuit breaker OPENED - using fallback after failure');
        return await fallback();
      }

      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
      console.log('Circuit breaker recovered - transitioning to CLOSED');
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      // Failed during recovery test, go back to open
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
      console.log('Circuit breaker recovery test failed - back to OPEN');
    } else if (this.failureCount >= this.config.failureThreshold) {
      // Too many failures, open the circuit
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
      console.log(`Circuit breaker OPENED after ${this.failureCount} failures`);
    }
  }

  /**
   * Get current circuit breaker status
   */
  getStatus(): { state: CircuitState; failureCount: number; lastFailureTime: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime
    };
  }

  /**
   * Manually reset the circuit breaker
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.nextAttemptTime = 0;
    console.log('Circuit breaker manually reset');
  }
}

/**
 * Default configuration for GitHub API circuit breaker
 */
export const GITHUB_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,      // Open after 3 consecutive failures
  recoveryTimeout: 30000,   // Wait 30 seconds before testing recovery
  monitoringWindow: 60000,  // Monitor failures within 1 minute window
};