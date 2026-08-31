import type { Session } from "./types.js";

const sessions = new Map<number, Session>();

export function getSession(id: number): Session {
  if (!sessions.has(id)) sessions.set(id, { screen: "home", stack: [], page: 0 });
  return sessions.get(id)!;
}

export function setSession(id: number, patch: Partial<Session>) {
  sessions.set(id, { ...getSession(id), ...patch });
}

export function pushScreen(id: number, screen: string) {
  const session = getSession(id);
  setSession(id, { screen, stack: [...session.stack, session.screen], page: 0 });
}

export function back(id: number): string {
  const session = getSession(id);
  const stack = [...session.stack];
  const screen = stack.pop() ?? "home";
  setSession(id, { screen, stack, page: 0 });
  return screen;
}

export function clearSession(id: number) {
  sessions.set(id, { screen: "home", stack: [], page: 0 });
}