import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { translate } from "../../lib/locale";
import { useUILocale } from "../../hooks/useUILocale";

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  prefill?: { id: string; text: string } | null;
}

export const ChatInput = ({ onSend, disabled, prefill }: ChatInputProps) => {
  const { locale } = useUILocale();
  const localize = useCallback(
    (key: string, fallback: string) => {
      const resolved = translate(key, locale);
      return resolved === key ? fallback : resolved;
    },
    [locale],
  );
  const [value, setValue] = useState("");
  const lastAppliedPrefillRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!value.trim()) return;
    onSend(value.trim());
    setValue("");
    lastAppliedPrefillRef.current = null;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!value.trim()) return;
      onSend(value.trim());
      setValue("");
      lastAppliedPrefillRef.current = null;
    }
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [value]);

  useEffect(() => {
    if (!prefill) return;
    if (prefill.id === lastAppliedPrefillRef.current) return;
    setValue(prefill.text ?? "");
    lastAppliedPrefillRef.current = prefill.id;
  }, [prefill]);

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-end gap-2 bg-transparent p-0"
    >
      <textarea
        ref={textareaRef}
        className="flex-1 min-h-[2.5rem] max-h-40 resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
        placeholder={localize(
          "chat_input_placeholder",
          "Ask the studio agent... (Shift+Enter for new line)",
        )}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={1}
      />
      <button
        type="submit"
        className="rounded-md bg-neutral-800 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        disabled={disabled || !value.trim()}
      >
        {localize("chat_input_send", "Send")}
      </button>
    </form>
  );
};
