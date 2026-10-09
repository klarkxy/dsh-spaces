import { z } from 'zod';

const tab = z.object({ id: z.string().uuid(), requestedUrl: z.string().url().nullable(), url: z.string().url().nullable(), title: z.string() }).strict();
const observation = z.object({ tabId: z.string().uuid(), url: z.string().url().max(2048), title: z.string() }).strict();
const sourceLocation = { file: 'packages/browser/src/remote.ts', line: 1, column: 1 };
const result = (typeSymbol: string, schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol, create: () => schema });
const invoke = (method: string, parameters: unknown[], schema: z.ZodType) => ({
  id: `@dsh-spaces/browser#spacesBrowser/${method}`,
  service: 'spacesBrowser', namespace: 'spacesBrowser', method,
  invocation: { kind: 'direct' as const }, parameters, result: result(`@dsh-spaces/browser#${method}:result`, schema), sourceLocation,
});

export const TYPERT = {
  package: '@dsh-spaces/browser', face: 'host', schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: [
    invoke('listTabs', [], tab.array()),
    invoke('openURL', [{
      name: 'url', wire: 'url', source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: '@dsh-spaces/browser#openURL:url', create: () => z.string().min(1).max(2048) },
    }], tab),
    invoke('observe', [{
      name: 'observations', wire: 'observations', source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: '@dsh-spaces/browser#observe:observations', create: () => observation.array().max(16) },
    }], tab.array()),
  ],
};
