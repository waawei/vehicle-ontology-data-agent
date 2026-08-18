export const preferenceKeys = Object.freeze({
  sidebar: "ontofleet.workbench.sidebar",
  theme: "ontofleet.workbench.theme",
});

export type PreferenceKey = (typeof preferenceKeys)[keyof typeof preferenceKeys];

export function readPreference(key: PreferenceKey): string | null {
  return window.localStorage.getItem(key);
}

export function writePreference(key: PreferenceKey, value: string): void {
  window.localStorage.setItem(key, value);
}
