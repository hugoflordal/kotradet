// Where the herd is kept. Everything the page needs lives in one document:
//   { config: {summer_pasture, eco_date}, snapshots: [{date, file, animals}],
//     notes: {id: {name, slaughter, sell, comment}}, namedays: {date: [names]} }
// The page only calls load() and save(doc), so the stores are interchangeable.

const KEY = 'kotradet.herd.v1';

export function emptyHerd() {
  return { config: {}, snapshots: [], notes: {}, namedays: {} };
}

function withDefaults(doc) {
  return { ...emptyHerd(), ...(doc || {}) };
}

// Kept in this browser only (localStorage).
export const browserStore = {
  name: 'den här webbläsaren',
  async load() {
    try {
      const raw = localStorage.getItem(KEY);
      return withDefaults(raw ? JSON.parse(raw) : null);
    } catch {
      return emptyHerd();
    }
  },
  async save(doc) {
    localStorage.setItem(KEY, JSON.stringify(doc));
  },
  clear() {
    try { localStorage.removeItem(KEY); } catch { /* nothing stored */ }
  },
};

// One row per logged-in user in the Supabase table `herds` (supabase/schema.sql).
// The first time a user logs in, a herd already kept in this browser moves to
// the server.
export function supabaseStore(client, user) {
  return {
    name: 'ditt konto',
    async load() {
      const { data, error } = await client.from('herds').select('doc').eq('user_id', user.id).maybeSingle();
      if (error) throw error;
      if (data) return withDefaults(data.doc);
      const local = await browserStore.load();
      if (local.snapshots.length || Object.keys(local.notes).length) {
        await this.save(local);
        browserStore.clear();
      }
      return local;
    },
    async save(doc) {
      const { error } = await client.from('herds')
        .upsert({ user_id: user.id, doc, updated_at: new Date().toISOString() });
      if (error) throw error;
    },
  };
}
