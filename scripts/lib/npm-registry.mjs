/** Public registry reads only: no credentials, redirects, retries or code loading. */
export async function readRegistryJson(name, version, { fetchImpl = fetch } = {}) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(20_000), redirect: 'error',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${name}@${version}: npm returned HTTP ${response.status}`); }
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 8 * 1024 * 1024) throw new Error('npm metadata exceeded 8 MiB');
      chunks.push(chunk);
    }
  } catch (error) { throw new Error(`${name}@${version}: registry read failed`, { cause: error }); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
