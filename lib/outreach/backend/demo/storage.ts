/**
 * `db.storage` in demo mode: buckets kept in memory for the session. Uploaded files become object URLs; nothing leaves
 * the browser. A reload forgets the bytes (the rows that point at them stay), which the UI treats like an expired link.
 */

type Obj = { blob: Blob; url: string; contentType: string; at: string };
const buckets = new Map<string, Map<string, Obj>>();

function bucket(name: string): Map<string, Obj> {
  let b = buckets.get(name);
  if (!b) { b = new Map(); buckets.set(name, b); }
  return b;
}

/** A stored file's bytes, for handlers that read what the UI uploaded (CSV imports, catalogues). */
export function readStored(bucketName: string, path: string): Blob | null {
  return bucket(bucketName).get(path)?.blob ?? null;
}
export function storedUrl(bucketName: string, path: string): string | null {
  return bucket(bucketName).get(path)?.url ?? null;
}

const ok = <T,>(data: T) => ({ data, error: null });
const notFound = () => ({ data: null, error: { message: 'Object not found', statusCode: '404' } });

function put(b: string, path: string, file: Blob | ArrayBuffer | string, contentType?: string) {
  const blob = file instanceof Blob ? file : new Blob([file], { type: contentType });
  const prev = bucket(b).get(path);
  if (prev) URL.revokeObjectURL(prev.url);
  bucket(b).set(path, { blob, url: URL.createObjectURL(blob), contentType: contentType ?? blob.type, at: new Date().toISOString() });
}

export function demoStorage() {
  return {
    from(b: string) {
      return {
        upload: async (path: string, file: Blob | ArrayBuffer | string, opts: { contentType?: string; upsert?: boolean } = {}) => {
          if (bucket(b).has(path) && !opts.upsert) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
          put(b, path, file, opts.contentType);
          return ok({ path, id: path, fullPath: `${b}/${path}` });
        },
        uploadToSignedUrl: async (path: string, _token: string, file: Blob | ArrayBuffer | string, opts: { contentType?: string } = {}) => {
          put(b, path, file, opts.contentType);
          return ok({ path, fullPath: `${b}/${path}` });
        },
        createSignedUploadUrl: async (path: string) => ok({ signedUrl: `demo://${b}/${path}`, token: 'demo', path }),
        update: async (path: string, file: Blob | ArrayBuffer | string, opts: { contentType?: string } = {}) => { put(b, path, file, opts.contentType); return ok({ path }); },
        createSignedUrl: async (path: string) => { const o = bucket(b).get(path); return o ? ok({ signedUrl: o.url }) : notFound(); },
        createSignedUrls: async (paths: string[]) => ok(paths.map((p) => ({ path: p, signedUrl: bucket(b).get(p)?.url ?? null, error: bucket(b).has(p) ? null : 'Not found' }))),
        getPublicUrl: (path: string) => ({ data: { publicUrl: bucket(b).get(path)?.url ?? `/widget/v1/presets/${path.split('/').pop()}` } }),
        download: async (path: string) => { const o = bucket(b).get(path); return o ? ok(o.blob) : notFound(); },
        remove: async (paths: string[]) => { for (const p of paths) { const o = bucket(b).get(p); if (o) URL.revokeObjectURL(o.url); bucket(b).delete(p); } return ok(paths.map((name) => ({ name }))); },
        list: async (prefix = '') => ok([...bucket(b).entries()].filter(([p]) => p.startsWith(prefix ? `${prefix.replace(/\/$/, '')}/` : '')).map(([p, o]) => ({ name: p.slice(prefix ? prefix.replace(/\/$/, '').length + 1 : 0), id: p, created_at: o.at, updated_at: o.at, metadata: { size: o.blob.size, mimetype: o.contentType } }))),
      };
    },
  };
}
