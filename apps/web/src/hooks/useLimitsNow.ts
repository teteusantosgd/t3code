import { useSyncExternalStore } from "react";

/**
 * One clock for every limits countdown, so Usage and the sidebar never drift
 * apart. It advances once a minute (the labels' resolution) and on
 * `bumpLimitsNow` when a refresh finishes.
 */

let limitsNow = Date.now();
let timerId: ReturnType<typeof setTimeout> | null = null;
let timerIsInterval = false;
const listeners = new Set<() => void>();

function publish(next: number): void {
  if (next === limitsNow) return;
  limitsNow = next;
  for (const listener of listeners) listener();
}

function tick(): void {
  publish(Date.now());
}

function unref(handle: ReturnType<typeof setTimeout>): void {
  if (typeof handle === "object" && handle !== null && "unref" in handle) handle.unref();
}

function startTimer(): void {
  timerIsInterval = false;
  timerId = setTimeout(
    () => {
      tick();
      timerIsInterval = true;
      timerId = setInterval(tick, 60_000);
      unref(timerId);
    },
    60_000 - (Date.now() % 60_000),
  );
  unref(timerId);
}

function stopTimer(): void {
  if (timerId === null) return;
  if (timerIsInterval) clearInterval(timerId);
  else clearTimeout(timerId);
  timerId = null;
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) startTimer();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopTimer();
  };
}

function getSnapshot(): number {
  // No subscriber yet: the stored instant may be from module load. Re-read
  // so the first paint is current, without notifying during render.
  if (listeners.size === 0) limitsNow = Date.now();
  return limitsNow;
}

/** Snap every limits countdown to the current instant. */
export function bumpLimitsNow(): void {
  publish(Date.now());
}

export function useLimitsNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
