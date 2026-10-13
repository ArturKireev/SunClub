export { Club } from './club.js';

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith('/api/')) return env.CLUB.get(env.CLUB.idFromName('sunclub')).fetch(req);
    return env.ASSETS.fetch(req);
  },
};
