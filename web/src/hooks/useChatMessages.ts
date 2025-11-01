import { useCallback, useRef, useState } from "react";
import type { ChatAction } from "../types/domain";

export type ChatMessageTone = "default" | "success" | "error";
export type ChatMessageRole = "assistant" | "user" | "system";

export interface ChatMessageBadge {
  label: string;
  description?: string;
  tone?: ChatMessageTone;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  text: string;
  badge?: ChatMessageBadge;
  actions?: ChatAction[];
  createdAt?: string | null;
  optimistic?: boolean;
  clientId?: string;
  serverId?: string | null;
}

interface ChatMessageRecord extends ChatMessage {
  order: number;
}

interface AppendOptions {
  optimistic?: boolean;
  serverId?: string | null;
  createdAt?: string | null;
}

export interface HistoryMessage
  extends Omit<ChatMessage, "optimistic" | "clientId" | "serverId"> {
  id: string;
  serverId?: string | null;
  createdAt?: string | null;
}

const normalizeText = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLowerCase();

export const useChatMessages = () => {
  const orderRef = useRef<number>(0);
  const [records, setRecords] = useState<ChatMessageRecord[]>([]);

  const nextOrder = useCallback((createdAt?: string | null) => {
    if (createdAt) {
      const ts = Date.parse(createdAt);
      if (!Number.isNaN(ts)) {
        if (ts <= orderRef.current) {
          orderRef.current += 1;
          return orderRef.current;
        }
        orderRef.current = ts;
        return ts;
      }
    }
    orderRef.current += 1;
    return orderRef.current;
  }, []);

  const addMessage = useCallback(
    (message: ChatMessage, options: AppendOptions = {}) => {
      setRecords((prev) => {
        const serverId = options.serverId ?? message.serverId ?? null;
        const optimistic = Boolean(options.optimistic ?? message.optimistic);
        const createdAt = options.createdAt ?? message.createdAt ?? null;
        const next = [...prev];

        if (serverId) {
          const existingIndex = next.findIndex(
            (entry) =>
              entry.id === serverId ||
              entry.serverId === serverId ||
              entry.clientId === serverId,
          );
          if (existingIndex !== -1) {
            const existing = next[existingIndex];
            const updated: ChatMessageRecord = {
              ...existing,
              ...message,
              id: serverId,
              serverId,
              optimistic: false,
              createdAt: createdAt ?? existing.createdAt ?? null,
              order: existing.order,
              clientId: existing.clientId ?? existing.id,
              actions: message.actions ?? existing.actions ?? [],
            };
            next[existingIndex] = updated;
            next.sort((a, b) => a.order - b.order);
            return next;
          }
        }

        const record: ChatMessageRecord = {
          ...message,
          actions: message.actions ?? [],
          optimistic,
          serverId:
            serverId ?? (optimistic ? null : (message.serverId ?? null)),
          clientId: message.clientId ?? (optimistic ? message.id : undefined),
          createdAt,
          order: nextOrder(createdAt),
        };

        next.push(record);
        next.sort((a, b) => a.order - b.order);
        return next;
      });
    },
    [nextOrder],
  );

  const updateMessage = useCallback(
    (id: string, updater: (message: ChatMessage) => ChatMessage) => {
      setRecords((prev) => {
        let changed = false;
        const next = prev.map((record) => {
          if (
            record.id === id ||
            record.clientId === id ||
            (record.serverId && record.serverId === id)
          ) {
            const updated = updater(record);
            if (updated === record) {
              return record;
            }
            const actions = Object.prototype.hasOwnProperty.call(
              updated,
              "actions",
            )
              ? updated.actions
              : record.actions;
            const badge = Object.prototype.hasOwnProperty.call(updated, "badge")
              ? updated.badge
              : record.badge;
            const optimistic = Object.prototype.hasOwnProperty.call(
              updated,
              "optimistic",
            )
              ? updated.optimistic
              : record.optimistic;
            changed = true;
            return {
              ...record,
              ...updated,
              id: updated.id ?? record.id,
              clientId: updated.clientId ?? record.clientId,
              serverId:
                typeof updated.serverId === "undefined"
                  ? (record.serverId ?? null)
                  : updated.serverId,
              optimistic,
              createdAt: updated.createdAt ?? record.createdAt ?? null,
              order: record.order,
              actions,
              badge,
            };
          }
          return record;
        });

        if (!changed) {
          return prev;
        }
        return next;
      });
    },
    [],
  );

  const syncHistory = useCallback(
    (historyMessages: HistoryMessage[]) => {
      if (!historyMessages.length) return;

      const orderedHistory = [...historyMessages].sort((a, b) => {
        const aTs = a.createdAt
          ? Date.parse(a.createdAt)
          : Number.POSITIVE_INFINITY;
        const bTs = b.createdAt
          ? Date.parse(b.createdAt)
          : Number.POSITIVE_INFINITY;
        return aTs - bTs;
      });

      setRecords((prev) => {
        let changed = false;
        const next = [...prev];

        for (const item of orderedHistory) {
          const serverId = item.serverId ?? item.id;
          const createdAt = item.createdAt ?? null;
          const existingIndex = next.findIndex(
            (entry) =>
              entry.id === serverId ||
              entry.serverId === serverId ||
              entry.clientId === serverId,
          );

          if (existingIndex !== -1) {
            const existing = next[existingIndex];
            const updated: ChatMessageRecord = {
              ...existing,
              ...item,
              id: serverId,
              serverId,
              optimistic: false,
              createdAt: createdAt ?? existing.createdAt ?? null,
              order: existing.order,
              clientId: existing.clientId ?? existing.id,
              actions: item.actions ?? existing.actions ?? [],
            };
            next[existingIndex] = updated;
            changed = true;
            continue;
          }

          const normalized = normalizeText(item.text);
          const optimisticIndex = next.findIndex(
            (entry) =>
              entry.optimistic &&
              entry.role === item.role &&
              normalizeText(entry.text) === normalized,
          );

          if (optimisticIndex !== -1) {
            const existing = next[optimisticIndex];
            const updated: ChatMessageRecord = {
              ...existing,
              ...item,
              id: serverId,
              serverId,
              optimistic: false,
              createdAt: createdAt ?? existing.createdAt ?? null,
              order: existing.order,
              clientId: existing.clientId ?? existing.id,
              actions: item.actions ?? existing.actions ?? [],
            };
            next[optimisticIndex] = updated;
            changed = true;
            continue;
          }

          const record: ChatMessageRecord = {
            ...item,
            id: serverId,
            serverId,
            optimistic: false,
            createdAt,
            order: nextOrder(createdAt),
            actions: item.actions ?? [],
          };
          next.push(record);
          changed = true;
        }

        if (!changed) {
          return prev;
        }

        next.sort((a, b) => a.order - b.order);
        return next;
      });
    },
    [nextOrder],
  );

  const reset = useCallback(() => {
    orderRef.current = 0;
    setRecords([]);
  }, []);

  return {
    messages: records as ChatMessage[],
    addMessage,
    updateMessage,
    syncHistory,
    reset,
  };
};
