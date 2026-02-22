export const WINDOW_SECONDS = 60;

export const computeRateLimitState = (
  limit: number,
  current: number,
  nowSeconds: number,
): { remaining: number; resetSeconds: number; blocked: boolean } => {
  const remaining = Math.max(0, limit - current);
  const resetSeconds = WINDOW_SECONDS - (nowSeconds % WINDOW_SECONDS);

  return {
    remaining,
    resetSeconds,
    blocked: current > limit,
  };
};
