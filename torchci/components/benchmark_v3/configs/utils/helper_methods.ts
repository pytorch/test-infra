
export const toNumberArray = (arr: string[]): number[] =>
  arr.map((v) => Number(v)).filter((n): n is number => !isNaN(n));
