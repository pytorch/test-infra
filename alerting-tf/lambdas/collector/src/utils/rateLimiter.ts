/**
 * Rate limiter for API calls with lambda-based execution
 * Ensures minimum interval between requests to prevent API abuse
 *
 * @example
 * ```typescript
 * const rateLimiter = new RateLimiter(10); // 10 requests per second
 *
 * // Simple API call
 * const response = await rateLimiter.execute(() =>
 *   fetch('https://api.github.com/user')
 * );
 *
 * // With complex logic
 * const result = await rateLimiter.execute(async () => {
 *   const response = await fetch(url, options);
 *   return response.json();
 * });
 *
 * // Return type inference works automatically
 * const data: UserData = await rateLimiter.execute(() => getUserData());
 *
 * // Synchronous operations also supported
 * const computed = await rateLimiter.execute(() => expensiveCalculation());
 * ```
 */
export class RateLimiter {
  private lastCallTime: number = 0;
  private readonly minInterval: number;

  constructor(requestsPerSecond: number = 10) {
    this.minInterval = 1000 / requestsPerSecond; // milliseconds between requests
  }

  /**
   * Execute a function with rate limiting applied
   * @param fn Function to execute (can be sync or async)
   * @returns Promise resolving to the function's return value
   */
  async execute<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.waitIfNeeded();
    return await fn();
  }

  private async waitIfNeeded(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;

    if (timeSinceLastCall < this.minInterval) {
      const waitTime = this.minInterval - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastCallTime = Date.now();
  }
}