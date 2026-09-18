import { join, resolve } from "node:path";

export const LLM_CONTROL_DIRNAME = ".dsh-spaces-control";
export const LLM_DIRNAME = "llm";
export const LLM_CATALOG_FILENAME = "catalog.json";
export const LLM_CREDENTIALS_FILENAME = "credentials.yaml";
export const LLM_POLICY_FILENAME = "llm-policy.json";

export function llmControlDir(home: string): string {
  return join(resolve(home), LLM_CONTROL_DIRNAME, LLM_DIRNAME);
}

export function llmCatalogPath(home: string): string {
  return join(llmControlDir(home), LLM_CATALOG_FILENAME);
}

export function llmCredentialsPath(home: string): string {
  return join(llmControlDir(home), LLM_CREDENTIALS_FILENAME);
}
