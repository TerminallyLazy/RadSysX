// Build/renderer children never need provider or clinical credentials. The
// backend alone receives the parent environment and reads its ignored .env.ai.
export function publicChildEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) => {
    if (/(?:API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(name) ||
        /^(?:GOOGLE_GENAI_|GEMINI_|RADSYSX_AI_)/i.test(name) ||
        /(?:DATABASE|DB|REDIS|BROKER)_URL$/i.test(name)) return false;
    try {
      const url = new URL(value);
      if (url.username || url.password) return false;
    } catch { /* Ordinary environment settings are not URLs. */ }
    return true;
  }));
}

export function serviceEnvironment(name, parent, overrides = {}) {
  const environment = { ...parent, ...overrides };
  return name === "backend" ? environment : publicChildEnvironment(environment);
}
