import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { Agent, type AgentContext } from "../../../packages/agui/src";

type AguiContextValue = {
  agent: (threadId: string) => Agent;
  setContext: (key: string, entry: AgentContext | null) => void;
};
const AguiContext = createContext<AguiContextValue | null>(null);

/**
 * Keeps one agent per conversation for the signed-in session, so a reply that is still
 * streaming survives the chat screen being hidden and shown again.
 */
export function AguiProvider({
  apiUrl,
  token,
  children,
}: {
  apiUrl: string;
  token: string;
  children: ReactNode;
}) {
  const value = useMemo<AguiContextValue>(() => {
    const agents = new Map<string, Agent>();
    const context = new Map<string, AgentContext>();
    return {
      agent: (threadId) => {
        let agent = agents.get(threadId);
        if (!agent) {
          agent = new Agent({
            url: `${apiUrl}/api/agui/run`,
            threadId,
            headers: () => ({ Authorization: `Bearer ${token}` }),
            context: () => [...context.values()],
          });
          agents.set(threadId, agent);
        }
        return agent;
      },
      setContext: (key, entry) => {
        if (entry) context.set(key, entry);
        else context.delete(key);
      },
    };
  }, [apiUrl, token]);
  return <AguiContext.Provider value={value}>{children}</AguiContext.Provider>;
}

function useAgui() {
  const value = useContext(AguiContext);
  if (!value) throw new Error("The agent provider is unavailable");
  return value;
}

/** The agent for one conversation; the component re-renders whenever its messages change. */
export function useAgent(threadId: string): Agent {
  const { agent: get } = useAgui();
  const agent = get(threadId);
  useSyncExternalStore(agent.subscribe, agent.getSnapshot, agent.getSnapshot);
  return agent;
}

/** Tells the agent about the current screen; sent with every run. */
export function useAgentContext(key: string, description: string, value: unknown) {
  const { setContext } = useAgui();
  const serialized = JSON.stringify(value);
  useEffect(() => {
    setContext(key, { description, value: serialized });
    return () => setContext(key, null);
  }, [setContext, key, description, serialized]);
}
