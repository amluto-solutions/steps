import { useEffect, useRef, type RefObject } from "react";

/**
 * A ref that always holds the latest `value`, for a callback registered once (an event listener,
 * a timer, a queued write) that must see the current props or state when it runs.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
