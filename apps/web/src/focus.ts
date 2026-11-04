import { useEffect, useRef, useState } from "react";

/** After an action removes the focused control, keep keyboard users on the page, not at the top. */
export function focusMainIfLost(): void {
  if (document.activeElement === document.body) document.getElementById("main")?.focus();
}

/** Moves focus to the first invalid field once its error has rendered, so it can be read and fixed. */
export function useFocusFirstInvalid() {
  const formRef = useRef<HTMLFormElement>(null);
  const [attempts, setAttempts] = useState(0);
  useEffect(() => {
    if (attempts > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [attempts]);
  return { formRef, focusFirstInvalid: () => setAttempts((count) => count + 1) };
}
