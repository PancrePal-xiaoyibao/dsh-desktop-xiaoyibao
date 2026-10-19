import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { generateUUID } from '@/lib/utils';

export type Message = {
  role: 'user' | 'assistant';
  content: string;
  id: string;
  createdAt: number;
};

export type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = 'xiaoyibao-storage-v2';
const LEGACY_STORAGE_KEY = ['xiao', 'xinbao-storage-v2'].join('');

const persistentStorage = createJSONStorage(() => ({
  getItem: (name: string) => {
    const currentValue = localStorage.getItem(name);
    if (currentValue !== null) {
      return currentValue;
    }

    if (name === STORAGE_KEY) {
      return localStorage.getItem(LEGACY_STORAGE_KEY);
    }

    return null;
  },
  setItem: (name: string, value: string) => {
    localStorage.setItem(name, value);
    if (name === STORAGE_KEY) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  },
  removeItem: (name: string) => {
    localStorage.removeItem(name);
    if (name === STORAGE_KEY) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  },
}));

interface ChatState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  hasAgreed: boolean;
  userId: string | null;
  isLoading: boolean;

  agreeToTerms: () => void;
  initUser: () => void;
  setAuthenticatedUser: (userId: string) => void;
  setSessionsSnapshot: (sessions: ChatSession[], activeSessionId: string | null) => void;
  resetForLogout: () => void;

  // Session Actions
  createNewSession: () => string;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  clearAllSessions: () => void;
  renameSession: (sessionId: string, title: string) => void;

  // Message Actions
  addMessage: (role: 'user' | 'assistant', content: string) => void;
  appendTokenToLastMessage: (token: string) => void;
  setLoading: (loading: boolean) => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      sessions: [],
      activeSessionId: null,
      hasAgreed: false,
      userId: null,
      isLoading: false,

      agreeToTerms: () => set({ hasAgreed: true }),

      setAuthenticatedUser: (userId) => set({ userId, hasAgreed: true }),

      setSessionsSnapshot: (sessions, activeSessionId) => {
        if (sessions.length === 0) {
          const id = generateUUID();
          const newSession: ChatSession = {
            id,
            title: '新对话',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          set({ sessions: [newSession], activeSessionId: newSession.id });
          return;
        }

        const nextActiveSessionId =
          activeSessionId && sessions.some((session) => session.id === activeSessionId)
            ? activeSessionId
            : sessions[0].id;
        set({ sessions, activeSessionId: nextActiveSessionId });
      },

      resetForLogout: () => set({
        sessions: [],
        activeSessionId: null,
        hasAgreed: false,
        userId: null,
        isLoading: false,
      }),

      initUser: () => {
        const { userId, sessions, activeSessionId } = get();

        const newState: Partial<ChatState> = {};

        if (!userId) {
          newState.userId = generateUUID();
        }

        // Initialize first session if none exists
        if (sessions.length === 0) {
          const newSession: ChatSession = {
            id: generateUUID(),
            title: '新对话',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          newState.sessions = [newSession];
          newState.activeSessionId = newSession.id;
        } else if (!activeSessionId) {
          newState.activeSessionId = sessions[0].id;
        }

        if (Object.keys(newState).length > 0) {
          set(newState);
        }
      },

      createNewSession: () => {
        const id = generateUUID();
        const newSession: ChatSession = {
          id,
          title: '新对话',
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((state) => ({
          sessions: [newSession, ...state.sessions],
          activeSessionId: id,
        }));
        return id;
      },

      switchSession: (sessionId) => set({ activeSessionId: sessionId }),

      deleteSession: (sessionId) => set((state) => {
        const newSessions = state.sessions.filter(s => s.id !== sessionId);
        let nextSessionId = state.activeSessionId;

        if (state.activeSessionId === sessionId) {
          nextSessionId = newSessions.length > 0 ? newSessions[0].id : null;
        }

        // If no sessions left, create a new one
        if (newSessions.length === 0) {
          const id = generateUUID();
          const newSession: ChatSession = {
            id,
            title: '新对话',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          return {
            sessions: [newSession],
            activeSessionId: id
          };
        }

        return {
          sessions: newSessions,
          activeSessionId: nextSessionId
        };
      }),

      clearAllSessions: () => {
        const id = generateUUID();
        const newSession: ChatSession = {
          id,
          title: '新对话',
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set({
          sessions: [newSession],
          activeSessionId: id
        });
      },

      renameSession: (sessionId, title) => set((state) => ({
        sessions: state.sessions.map(s => s.id === sessionId ? { ...s, title, updatedAt: Date.now() } : s)
      })),

      addMessage: (role, content) => set((state) => {
        const { activeSessionId, sessions } = state;
        if (!activeSessionId) return state;

        const newSessions = sessions.map(session => {
          if (session.id === activeSessionId) {
            const newMessages: Message[] = [
              ...session.messages,
              {
                role,
                content,
                id: generateUUID(),
                createdAt: Date.now(),
              },
            ];

            // Auto-generate title from first user message if it's "新对话"
            let title = session.title;
            if (role === 'user' && (title === '新对话' || !title)) {
              title = content.length > 15 ? content.substring(0, 15) + '...' : content;
            }

            return {
              ...session,
              messages: newMessages,
              title,
              updatedAt: Date.now(),
            };
          }
          return session;
        });

        return { sessions: newSessions };
      }),

      appendTokenToLastMessage: (token) => set((state) => {
        const { activeSessionId, sessions } = state;
        if (!activeSessionId) return state;

        const newSessions = sessions.map(session => {
          if (session.id === activeSessionId) {
            const messages = [...session.messages];
            if (messages.length === 0) return session;

            const lastMsg = { ...messages[messages.length - 1] };
            if (lastMsg.role === 'assistant') {
              lastMsg.content += token;
              messages[messages.length - 1] = lastMsg;
            }

            return {
              ...session,
              messages,
              updatedAt: Date.now(),
            };
          }
          return session;
        });

        return { sessions: newSessions };
      }),

      setLoading: (isLoading) => set({ isLoading }),
    }),
    {
      name: STORAGE_KEY,
      storage: persistentStorage,
      partialize: (state) => ({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        hasAgreed: state.hasAgreed,
        userId: state.userId
      }),
    }
  )
);
