import type React from "react";

export const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, label, [data-collapsible-ignore]";

export const isEventFromInteractive = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  Boolean(target.closest(INTERACTIVE_SELECTOR));

export const handleKeyboardToggle = <T extends HTMLElement>(
  event: React.KeyboardEvent<T>,
  toggle: () => void,
) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggle();
  }
};
