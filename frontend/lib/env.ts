export {
  getAppMode,
  getBackendBaseUrl,
  getPublicAppMode,
  getViewerBaseUrl,
  isExperimentalImagingEnabled,
  isResearchMode,
} from "@radsysx/clinical-web/env";
export type { AppMode } from "@radsysx/clinical-web/env";
import { getAppMode } from "@radsysx/clinical-web/env";

export function getGeminiApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Configure it only for research workflows.",
    );
  }
  return apiKey;
}

export function validateEnv() {
  if (getAppMode() === "research") {
    try {
      getGeminiApiKey();
    } catch (error) {
      if (process.env.NODE_ENV === "production") {
        throw error;
      }
      console.warn("Research-only Gemini features are unavailable.");
    }
  }
}
