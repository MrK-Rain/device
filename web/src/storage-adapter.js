/**
 * The prototype UI was written against window.storage, a key-value store that
 * only exists inside the Claude artifact sandbox. This supplies the same
 * interface so the component runs unmodified outside it.
 *
 * Two backends:
 *   local  browser localStorage. Development only. Same ~5MB ceiling that
 *          makes the prototype unsuitable as the real platform.
 *   api    the server. Not implemented yet — it throws loudly rather than
 *          silently pretending, so nobody mistakes this for a working
 *          deployment.
 *
 * Selected by VITE_STORAGE_BACKEND. Defaults to local.
 */

const PREFIX = "device-registry:";

function localBackend() {
  const key = (k) => PREFIX + k;
  return {
    async get(k) {
      const v = window.localStorage.getItem(key(k));
      if (v === null) throw new Error(`key not found: ${k}`);
      return { key: k, value: v, shared: false };
    },
    async set(k, value) {
      try {
        window.localStorage.setItem(key(k), value);
      } catch (e) {
        // Almost certainly the quota. Say so plainly; the generic
        // DOMException wording sends people down the wrong path.
        throw new Error(
          `local storage rejected the write (likely the ~5MB quota). ` +
            `This backend is for development only. Original: ${e.name}`
        );
      }
      return { key: k, value, shared: false };
    },
    async delete(k) {
      window.localStorage.removeItem(key(k));
      return { key: k, deleted: true, shared: false };
    },
    async list(prefix = "") {
      const keys = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const raw = window.localStorage.key(i);
        if (raw?.startsWith(PREFIX + prefix)) keys.push(raw.slice(PREFIX.length));
      }
      return { keys, prefix, shared: false };
    },
  };
}

function apiBackend(base) {
  const notReady = (op) => {
    throw new Error(
      `storage.${op} is unavailable: the API layer has not been built yet. ` +
        `Set VITE_STORAGE_BACKEND=local for development, or implement the ` +
        `client against ${base}.`
    );
  };
  return {
    async get() { notReady("get"); },
    async set() { notReady("set"); },
    async delete() { notReady("delete"); },
    async list() { notReady("list"); },
  };
}

export function installStorage() {
  const backend = import.meta.env.VITE_STORAGE_BACKEND ?? "local";
  const base = import.meta.env.VITE_API_BASE ?? "";

  if (backend === "api") {
    if (!base) throw new Error("VITE_STORAGE_BACKEND=api requires VITE_API_BASE");
    window.storage = apiBackend(base);
    return "api";
  }

  if (backend !== "local") {
    throw new Error(`unknown VITE_STORAGE_BACKEND: ${backend}`);
  }

  window.storage = localBackend();
  if (import.meta.env.PROD) {
    // Loud, because shipping this backend to users would mean per-browser
    // data with no audit trail and no server-side screening.
    console.warn(
      "[device-registry] running on the localStorage backend in a production " +
        "build. Records live in this browser only, are not audited, and are " +
        "not screened server-side. Do not use this with real fleet data."
    );
  }
  return "local";
}
