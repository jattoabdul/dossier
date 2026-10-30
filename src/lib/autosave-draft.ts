const PREFIX = "dossier:autosave:v1:";
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
export const subscribeAutosaveDrafts = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function autosaveDraftKeys(): string[] {
  try { return Object.keys(sessionStorage).filter((key) => key.startsWith(PREFIX)).map((key) => key.slice(PREFIX.length)).sort(); }
  catch { return []; }
}
export const autosaveDraftSnapshot = () => JSON.stringify(autosaveDraftKeys());
export const emptyDraftSnapshot = () => "[]";
export function draftDestination(key: string): { href: string; label: string } {
  if (key.startsWith("application:")) return { href: `/applications/${encodeURIComponent(key.split(":")[1])}`, label: "Application facts" };
  const section = key.split(":")[0];
  if (section === "settings") return key.endsWith("agent-query") ? { href: "/settings?section=agent", label: "Job agent" } : { href: "/settings?section=documents", label: "Document settings" };
  const sections: Record<string, string> = { publication: "publications", education: "education", reference: "references", experience: "experience", project: "projects", fact: "facts" };
  return { href: `/profile?section=${sections[section] ?? "basics"}`, label: sections[section] ?? "Profile basics" };
}
export type AutosaveDraft<T> = { base: T; value: T };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Only explicitly opted-in form values belong here. Never pass keys, tokens or passwords. */
export function writeAutosaveDraft<T>(key: string, draft: AutosaveDraft<T>): boolean {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(draft));
    notify();
    return true;
  } catch { return false; }
}

export function clearAutosaveDraft(key: string) {
  try { sessionStorage.removeItem(PREFIX + key); notify(); } catch { /* Storage can be disabled. */ }
}

export function clearAllAutosaveDrafts() {
  for (const key of autosaveDraftKeys()) clearAutosaveDraft(key);
}

function compatible(value: unknown, template: unknown): boolean {
  if (template === null) return value === null || typeof value === "string" || typeof value === "number";
  if (Array.isArray(template)) return Array.isArray(value) && value.every((item) =>
    template.length ? compatible(item, template[0]) : typeof item === "string");
  if (typeof template !== "object") return typeof value === typeof template;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = template as Record<string, unknown>;
  const draft = value as Record<string, unknown>;
  return Object.keys(fields).length === Object.keys(draft).length && Object.entries(fields).every(([key, item]) =>
    Object.hasOwn(draft, key) && compatible(draft[key], item) && (key !== "id" || draft[key] === item));
}

export function readAutosaveDraft<T>(key: string, current: T): AutosaveDraft<T> | null {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(PREFIX + key) ?? "null");
    if (!raw || typeof raw !== "object" || !("base" in raw) || !("value" in raw)) return null;
    if (!(compatible(raw.base, current) || compatible(current, raw.base)) || !compatible(raw.value, raw.base)) return null;
    return raw as AutosaveDraft<T>;
  } catch { return null; }
}

export { same as sameDraftValue };
