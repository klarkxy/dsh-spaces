import { AttachmentStore, type ImageAttachmentRef, type ImageRequestTarget, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment';
import type { Context } from '@deepseek-ai/cordis';
import type { AsyncLocalStorage } from 'node:async_hooks';
import type {} from '@deepseek-ai/dsh-fs';
export interface MainImageScope {
    local?: boolean;
    revoked: boolean;
    paths: Map<string, string>;
    images?: {
        origin: string;
        bearer: string;
    };
}
export interface MainImageSource {
    store: AttachmentStore;
    fs: Context['fs'];
    storage: AsyncLocalStorage<MainImageScope>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        spacesMainAttachmentSource: MainImageSource;
    }
}
export const inject = ['spacesMainAttachmentSource'];
export async function readSourceImage(scope: MainImageScope, ref: unknown, target: unknown, signal?: AbortSignal): Promise<any> {
    if (scope.revoked || !scope.images)
        throw new Error('IMAGE_SCOPE_MISSING');
    const response = await fetch(scope.images.origin, { method: 'POST', redirect: 'error', signal, headers: { authorization: `Bearer ${scope.images.bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ ref, target }) });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error('SOURCE_IMAGE_REFUSED');
    }
    return response.json();
}
export function apply(ctx: Context) {
    const source = ctx.spacesMainAttachmentSource;
    function scope() { const value = source.storage.getStore(); if (!value || value.revoked)
        throw new Error('IMAGE_SCOPE_MISSING'); return value; }
    class ScopedImages extends AttachmentStore {
        get imageLimits() { return source.store.imageLimits; }
        validateImage(input: SaveImageAttachment) { return source.store.validateImage(input); }
        saveImage(input: SaveImageAttachment) { return source.store.saveImage(input); }
        readImage(ref: ImageAttachmentRef, signal?: AbortSignal) { if (!scope().local)
            throw new Error('REQUEST_IMAGE_READER_REQUIRED'); return source.store.readImage(ref, signal); }
        imageHostPath(ref: ImageAttachmentRef) { const value = scope(); if (value.local)
            return source.store.imageHostPath(ref); const path = value.paths.get(ref.attachmentId); if (!path)
            throw new Error('IMAGE_NOT_GRANTED'); return path; }
        fileHostPath(): never { throw new Error('SOURCE_FILE_PROJECTION_REQUIRED'); }
        async readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal) { const value = scope(); if (value.local)
            return source.store.readImageRequest(ref, target, signal); const wire = await readSourceImage(value, ref, target, signal); return { ...wire, data: Buffer.from(wire.data, 'base64') }; }
    }
    new ScopedImages(ctx);
    ctx.provide('fs', { processPathFromHostPath(path: string) { const value = scope(); if (value.local)
            return source.fs.processPathFromHostPath(path); if (![...value.paths.values()].includes(path))
            throw new Error('IMAGE_NOT_GRANTED'); return path; } } as Context['fs']);
}
export default { inject, apply };
