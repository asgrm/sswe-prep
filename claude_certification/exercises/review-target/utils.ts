import { log } from "./logger";

export function unique<T>(items: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < items.length; i++) {
    if (out.indexOf(items[i]) === -1) {
      out.push(items[i]);
    }
  }
  return out;
}

export function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a) == JSON.stringify(b);
}

export function sortByPrice<T extends { price: number }>(items: T[]): T[] {
  return items.sort((x, y) => x.price - y.price);
}

export function isBlank(s?: string): boolean {
  return s == undefined || s == "";
}

export function pluck<T>(items: any[], key: string): T[] {
  log("pluck " + key);
  return items.map((i) => i[key]);
}

/** Split an array into chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Group items by a string key derived from each element. */
export function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyOf(item);
    (out[key] ??= []).push(item);
  }
  return out;
}

/** Inclusive integer range [start, end]. */
export function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i++) {
    out.push(i);
  }
  return out;
}

/** Sum a numeric projection over a list. */
export function sumBy<T>(items: T[], valueOf: (item: T) => number): number {
  return items.reduce((acc, item) => acc + valueOf(item), 0);
}

/** The last element, or undefined for an empty array. */
export function last<T>(items: T[]): T | undefined {
  return items.length === 0 ? undefined : items[items.length - 1];
}
