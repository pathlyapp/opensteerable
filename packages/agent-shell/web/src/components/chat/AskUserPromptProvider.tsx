import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getElectronBridge, type AskUserPromptRequest } from '@/lib/electron-bridge';

type AnswerValue = string | string[];

interface AskUserPromptContextValue {
  queue: AskUserPromptRequest[];
  answer: (requestId: string, answers: Record<string, AnswerValue>) => void;
}

interface AskUserPromptView {
  current: AskUserPromptRequest | null;
  pendingCount: number;
  answer: (answers: Record<string, AnswerValue>) => void;
}

/**
 * Chat id from `#/agent/:chatId` (hash router) or `/agent/:chatId`.
 * The running server build drops `chatId` on the ask-user payload.
 */
function chatIdFromLocation(location: { pathname: string; hash: string }): string | null {
  const hashed = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  const raw = hashed || location.pathname;
  const match = raw.match(/\/agent\/([^/?#]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function bindPromptToActiveChat(request: AskUserPromptRequest): AskUserPromptRequest {
  if (request.chatId) return request;
  const chatId = chatIdFromLocation(window.location);
  if (!chatId) return request;
  return { ...request, chatId };
}

/** A prompt with a chat id belongs only to that chat. A prompt without one stays visible so an older request is still answerable. */
function promptVisibleInChat(
  request: AskUserPromptRequest,
  chatId: string | null | undefined,
): boolean {
  if (!request.chatId) return !chatId;
  return request.chatId === chatId;
}

const AskUserPromptContext = createContext<AskUserPromptContextValue | null>(null);

/**
 * Keeps structured user prompts alive across chat navigation. Each composer
 * presents only the prompt that belongs to its chat.
 */
export function AskUserPromptProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<AskUserPromptRequest[]>([]);
  const answeredRequestIds = useRef(new Set<string>());

  useEffect(() => {
    const bridge = getElectronBridge();
    if (!bridge?.askUser) return;
    let active = true;
    const addRequests = (
      requests: AskUserPromptRequest[],
      placement: 'append' | 'prepend' = 'append',
    ) => {
      setQueue((previous) => {
        const known = new Set(previous.map(({ requestId }) => requestId));
        const additions = requests
          .filter(
            ({ requestId }) =>
              !known.has(requestId) && !answeredRequestIds.current.has(requestId),
          )
          .map(bindPromptToActiveChat);
        if (additions.length === 0) return previous;
        return placement === 'prepend'
          ? [...additions, ...previous]
          : [...previous, ...additions];
      });
    };
    const unsubscribe = bridge.askUser.onRequest((request) => {
      addRequests([request]);
    });
    void bridge.askUser
      .pending()
      .then((requests) => {
        if (active) addRequests(requests, 'prepend');
      })
      .catch((error) => {
        console.error('恢复待回答问题失败:', error);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const answer = useCallback(
    (requestId: string, answers: Record<string, AnswerValue>) => {
      const bridge = getElectronBridge();
      answeredRequestIds.current.add(requestId);
      setQueue((previous) => previous.filter((request) => request.requestId !== requestId));
      void bridge?.askUser?.answer({ requestId, answers });
    },
    [],
  );

  const value = useMemo(
    () => ({
      queue,
      answer,
    }),
    [answer, queue],
  );

  return (
    <AskUserPromptContext.Provider value={value}>
      {children}
    </AskUserPromptContext.Provider>
  );
}

/** Returns the structured prompt for this composer’s chat, if one is waiting. */
export function useAskUserPrompt(chatId?: string | null): AskUserPromptView | null {
  const context = useContext(AskUserPromptContext);
  return useMemo(() => {
    if (!context) return null;
    const mine = context.queue.filter((request) => promptVisibleInChat(request, chatId));
    const current = mine[0] ?? null;
    return {
      current,
      pendingCount: Math.max(0, mine.length - 1),
      answer: (answers) => {
        if (!current) return;
        context.answer(current.requestId, answers);
      },
    };
  }, [chatId, context]);
}
