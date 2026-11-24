const API_BASE = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

const encodePath = path => path.split('/').map(encodeURIComponent).join('/');

function bytesToBinary(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return binary;
}

export function decodeBase64(value) {
  const binary = atob((value || '').replace(/\s+/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

export function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function createClient(token, fetchImpl = fetch) {
  if (!token) throw new Error('缺少 GitHub token');

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gdr-admin',
  };

  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetchImpl(API_BASE + path, {
      method,
      headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!response.ok) {
      throw new GitHubError(data?.message || `HTTP ${response.status}`, response.status, data);
    }
    return data;
  }

  return {
    request,
    getTree: (owner, repo, ref) => request(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`),
    async getFile(owner, repo, path, ref) {
      try {
        const data = await request(`/repos/${owner}/${repo}/contents/${encodePath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
        if (Array.isArray(data)) return { list: data };
        return { path: data.path, sha: data.sha, content: decodeBase64(data.content) };
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },
    getRef: (owner, repo, branch) => request(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`),
    getCommit: (owner, repo, sha) => request(`/repos/${owner}/${repo}/git/commits/${sha}`),
    createBlob: (owner, repo, content) => request(`/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST', body: { content, encoding: 'utf-8' },
    }),
    createTree: (owner, repo, body) => request(`/repos/${owner}/${repo}/git/trees`, { method: 'POST', body }),
    createCommit: (owner, repo, body) => request(`/repos/${owner}/${repo}/git/commits`, { method: 'POST', body }),
    patchRef: (owner, repo, branch, sha) => request(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH', body: { sha, force: false },
    }),
    putFile: (owner, repo, path, { message, content, sha, branch }) => request(
      `/repos/${owner}/${repo}/contents/${encodePath(path)}`,
      { method: 'PUT', body: { message, content: encodeBase64(content), branch, ...(sha ? { sha } : {}) } },
    ),
    deleteFile: (owner, repo, path, { message, sha, branch }) => request(
      `/repos/${owner}/${repo}/contents/${encodePath(path)}`,
      { method: 'DELETE', body: { message, sha, branch } },
    ),
  };
}
