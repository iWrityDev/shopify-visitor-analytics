const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'analytics-data.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'analytics2024';

// CORS - allow all Shopify store domains
app.use(cors({
    origin: function(origin, callback) {
          // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);
          // Allow all .myshopify.com and store domains
      const allowed = [
              /\.myshopify\.com$/,
              /^https?:\/\/(www\.)?skriuwer\.com$/,
              /^https?:\/\/(www\.)?masterlanguage\.com$/,
              /^https?:\/\/localhost/,
            ];
          const isAllowed = allowed.some(pattern => pattern.test(origin));
          callback(null, isAllowed || true); // Allow all for now
    },
    credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Also parse text/plain as JSON (used by navigator.sendBeacon)
app.use((req, res, next) => {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('text/plain') && req.method === 'POST') {
          let raw = '';
          req.on('data', chunk => { raw += chunk; });
          req.on('end', () => {
                  try { req.body = JSON.parse(raw); } catch(e) { req.body = {}; }
                  next();
          });
    } else {
          next();
    }
});

// Serve static files (admin dashboard)
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// Helper: load data
function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
          fs.writeFileSync(DATA_FILE, JSON.stringify({ sessions: {} }));
    }
    try {
          return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
          return { sessions: {} };
    }
}

// Helper: save data
function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Helper: purge old sessions (older than 30 days)
function purgeOldSessions(data) {
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let purged = 0;
    Object.keys(data.sessions).forEach(id => {
          const session = data.sessions[id];
          if (session.startTime < cutoff) {
                  delete data.sessions[id];
                  purged++;
          }
    });
    if (purged > 0) {
          console.log('Purged ' + purged + ' old sessions');
    }
}

// Helper: detect device type
function detectDevice(ua) {
    if (!ua) return 'unknown';
    if (/tablet|ipad/i.test(ua)) return 'tablet';
    if (/mobile|android|iphone/i.test(ua)) return 'mobile';
    return 'desktop';
}

// Helper: extract country from headers
function getCountry(req) {
    return req.headers['cf-ipcountry'] ||
          req.headers['x-vercel-ip-country'] ||
          req.headers['x-country'] ||
          'unknown';
}

// POST /api/track - receive all event types
app.post('/api/track', (req, res) => {
    try {
          const body = req.body;
          const { type, sessionId, page, store, referrer, scrollDepth, totalTime, event } = body;

      if (!sessionId) {
              return res.status(200).json({ ok: true, message: 'No session ID' });
      }

      const data = loadData();

      // Create session if it doesn't exist
      if (!data.sessions[sessionId]) {
              data.sessions[sessionId] = {
                        sessionId,
                        startTime: Date.now(),
                        lastHeartbeat: Date.now(),
                        pages: [],
                        scrollDepths: {},
                        referrer: referrer || '',
                        device: detectDevice(req.headers['user-agent']),
                        converted: false,
                        bounced: true,
                        totalTime: 0,
                        country: getCountry(req),
                        store: store || 'unknown',
                        conversionType: null,
                        events: []
              };
      }

      const session = data.sessions[sessionId];
          session.lastHeartbeat = Date.now();

      // Store update
      if (store && store !== session.store) {
              session.store = store;
      }

      // Process by event type
      if (type === 'pageview') {
              if (page && !session.pages.includes(page)) {
                        session.pages.push(page);
              } else if (page && session.pages[session.pages.length - 1] !== page) {
                        session.pages.push(page);
              }
              // Check for conversion pages
            if (page) {
                      if (page.includes('/thank_you') || page.includes('/orders')) {
                                  session.converted = true;
                                  session.conversionType = 'order';
                      } else if (page.includes('/checkout')) {
                                  if (!session.converted) session.conversionType = 'checkout';
                      }
            }
              // Bounced = only 1 page viewed (updated on each pageview)
            session.bounced = session.pages.length <= 1;

      } else if (type === 'heartbeat') {
              // Just update lastHeartbeat (already done above)

      } else if (type === 'scroll') {
              if (page && scrollDepth !== undefined) {
                        const currentMax = session.scrollDepths[page] || 0;
                        session.scrollDepths[page] = Math.max(currentMax, scrollDepth);
              }

      } else if (type === 'exit') {
              if (totalTime) {
                        session.totalTime = Math.max(session.totalTime, totalTime);
              } else {
                        // Fallback: derive from heartbeat diff if no totalTime provided
                const derived = Math.round((session.lastHeartbeat - session.startTime) / 1000);
                        if (derived > 0) {
                                    session.totalTime = Math.max(session.totalTime, derived);
                        }
              }
              session.bounced = session.pages.length <= 1;

      } else if (type === 'conversion') {
              session.converted = true;
              session.conversionType = event || 'unknown';
              if (page && !session.pages.includes(page)) {
                        session.pages.push(page);
              }
      }

      // Purge old sessions periodically (1% chance per request)
      if (Math.random() < 0.01) {
              purgeOldSessions(data);
      }

      saveData(data);
          res.status(200).json({ ok: true, sessionId });
    } catch (e) {
          console.error('Track error:', e.message);
          res.status(200).json({ ok: true, error: 'Internal error (graceful)' });
    }
});

// GET /api/track/exclude - set/remove vtexclude cookie
app.get('/api/track/exclude', (req, res) => {
    const action = req.query.action || 'set';
    const redirectUrl = req.query.redirect || '/admin/visitor-analytics.html';
    if (action === 'remove') {
          res.cookie('vtexclude', '', { maxAge: 0, httpOnly: false, sameSite: 'None', secure: true });
          res.json({ ok: true, message: 'Exclusion removed' });
    } else {
          res.cookie('vtexclude', '1', { maxAge: 365 * 24 * 60 * 60, httpOnly: false, sameSite: 'None', secure: true });
          res.json({ ok: true, message: 'Visits will be excluded' });
    }
});

// GET /api/analytics/stats
app.get('/api/analytics/stats', (req, res) => {
    try {
          const days = parseInt(req.query.days) || 7;
          const store = req.query.store || null;
          const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
          const data = loadData();

      const sessions = Object.values(data.sessions).filter(s => {
              if (s.startTime < cutoff) return false;
              if (store && store !== 'all' && s.store !== store) return false;
              return true;
      });

      // Aggregate stats
      const totalVisitors = sessions.length;
          const conversions = sessions.filter(s => s.converted).length;
          const bounces = sessions.filter(s => s.bounced).length;
          const conversionRate = totalVisitors > 0 ? (conversions / totalVisitors * 100).toFixed(1) : '0';
          const bounceRate = totalVisitors > 0 ? (bounces / totalVisitors * 100).toFixed(1) : '0';

      // Avg time on site (non-bounced sessions with recorded time)
      const nonBounced = sessions.filter(s => !s.bounced && s.totalTime > 0);
          const avgTime = nonBounced.length > 0
            ? Math.round(nonBounced.reduce((sum, s) => sum + s.totalTime, 0) / nonBounced.length)
                  : 0;

      // Avg bounce time: use totalTime if recorded, else fall back to heartbeat diff
      const bouncedSessions = sessions.filter(s => s.bounced);
          const bounceTimes = bouncedSessions.map(s => {
                  if (s.totalTime > 0) return s.totalTime;
                  const hbDiff = Math.round((s.lastHeartbeat - s.startTime) / 1000);
                  return hbDiff > 0 ? hbDiff : 0;
          }).filter(t => t > 0);
          const avgBounceTime = bounceTimes.length > 0
            ? Math.round(bounceTimes.reduce((a, b) => a + b, 0) / bounceTimes.length)
                  : 0;

      // Pages per visit
      const avgPages = totalVisitors > 0
            ? (sessions.reduce((sum, s) => sum + s.pages.length, 0) / totalVisitors).toFixed(1)
              : '0';

      // Daily breakdown (last N days)
      const dailyMap = {};
          sessions.forEach(s => {
                  const day = new Date(s.startTime).toISOString().split('T')[0];
                  if (!dailyMap[day]) dailyMap[day] = { visitors: 0, conversions: 0 };
                  dailyMap[day].visitors++;
                  if (s.converted) dailyMap[day].conversions++;
          });
          const daily = Object.keys(dailyMap).sort().map(day => ({
                  date: day,
                  visitors: dailyMap[day].visitors,
                  conversions: dailyMap[day].conversions
          }));

      // Country breakdown
      const countryMap = {};
          sessions.forEach(s => {
                  const c = s.country || 'unknown';
                  if (!countryMap[c]) countryMap[c] = { visitors: 0, conversions: 0 };
                  countryMap[c].visitors++;
                  if (s.converted) countryMap[c].conversions++;
          });
          const countries = Object.keys(countryMap)
            .sort((a, b) => countryMap[b].visitors - countryMap[a].visitors)
            .slice(0, 10)
            .map(c => ({
                      country: c,
                      visitors: countryMap[c].visitors,
                      conversions: countryMap[c].conversions,
                      conversionRate: (countryMap[c].conversions / countryMap[c].visitors * 100).toFixed(1)
            }));

      // Device breakdown
      const deviceMap = {};
          sessions.forEach(s => {
                  const d = s.device || 'unknown';
                  if (!deviceMap[d]) deviceMap[d] = 0;
                  deviceMap[d]++;
          });

      // Traffic sources
      const sourceMap = {};
          sessions.forEach(s => {
                  let source = 'Direct';
                  if (s.referrer) {
                            try {
                                        const url = new URL(s.referrer);
                                        const host = url.hostname.replace('www.', '');
                                        if (host.includes('google')) source = 'Google';
                                        else if (host.includes('facebook') || host.includes('fb.com')) source = 'Facebook';
                                        else if (host.includes('instagram')) source = 'Instagram';
                                        else if (host.includes('twitter') || host.includes('x.com')) source = 'Twitter/X';
                                        else if (host.includes('tiktok')) source = 'TikTok';
                                        else if (host.includes('pinterest')) source = 'Pinterest';
                                        else if (host.includes('bing')) source = 'Bing';
                                        else source = host;
                            } catch(e) { source = 'Direct'; }
                  }
                  if (!sourceMap[source]) sourceMap[source] = 0;
                  sourceMap[source]++;
          });
          const sources = Object.keys(sourceMap)
            .sort((a, b) => sourceMap[b] - sourceMap[a])
            .map(s => ({ source: s, count: sourceMap[s] }));

      // Funnel
      const productViews = sessions.filter(s => s.pages.some(p => p.includes('/products/'))).length;
          const cartViews = sessions.filter(s => s.pages.some(p => p.includes('/cart'))).length;
          const checkoutViews = sessions.filter(s => s.pages.some(p => p.includes('/checkout'))).length;
          const orderViews = sessions.filter(s => s.converted).length;

      res.json({
              ok: true,
              stats: {
                        totalVisitors,
                        conversions,
                        conversionRate: parseFloat(conversionRate),
                        bounceRate: parseFloat(bounceRate),
                        avgTime,
                        avgBounceTime,
                        avgPages: parseFloat(avgPages),
                        daily,
                        countries,
                        devices: deviceMap,
                        sources,
                        funnel: { productViews, cartViews, checkoutViews, orders: orderViews }
              }
      });
    } catch (e) {
          console.error('Stats error:', e.message);
          res.status(200).json({ ok: true, error: e.message, stats: {} });
    }
});

// GET /api/analytics/sessions
app.get('/api/analytics/sessions', (req, res) => {
    try {
          const store = req.query.store || null;
          const limit = parseInt(req.query.limit) || 100;
          const data = loadData();

      let sessions = Object.values(data.sessions);
          if (store && store !== 'all') {
                  sessions = sessions.filter(s => s.store === store);
          }
          // Sort by most recent
      sessions.sort((a, b) => b.startTime - a.startTime);
          sessions = sessions.slice(0, limit);

      res.json({ ok: true, sessions });
    } catch (e) {
          res.status(200).json({ ok: true, error: e.message, sessions: [] });
    }
});

// GET /api/analytics/realtime
app.get('/api/analytics/realtime', (req, res) => {
    try {
          const store = req.query.store || null;
          const data = loadData();
          // Only sessions with a heartbeat in the last 2 minutes
      const cutoff = Date.now() - (2 * 60 * 1000);

      let sessions = Object.values(data.sessions).filter(s => {
              if (s.lastHeartbeat < cutoff) return false;
              if (store && store !== 'all' && s.store !== store) return false;
              return true;
      });

      res.json({
              ok: true,
              liveCount: sessions.length,
              sessions: sessions.map(s => ({
                        sessionId: s.sessionId,
                        currentPage: s.pages[s.pages.length - 1] || '/',
                        device: s.device,
                        country: s.country,
                        store: s.store,
                        startTime: s.startTime,
                        lastHeartbeat: s.lastHeartbeat
              }))
      });
    } catch (e) {
          res.status(200).json({ ok: true, error: e.message, liveCount: 0, sessions: [] });
    }
});

// GET /api/analytics/pages
app.get('/api/analytics/pages', (req, res) => {
    try {
          const store = req.query.store || null;
          const days = parseInt(req.query.days) || 7;
          const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
          const data = loadData();

      let sessions = Object.values(data.sessions).filter(s => {
              if (s.startTime < cutoff) return false;
              if (store && store !== 'all' && s.store !== store) return false;
              return true;
      });

      const pageMap = {};
          sessions.forEach(s => {
                  s.pages.forEach(page => {
                            if (!pageMap[page]) pageMap[page] = { views: 0, totalScroll: 0, scrollCount: 0 };
                            pageMap[page].views++;
                            const scroll = s.scrollDepths[page];
                            if (scroll) {
                                        pageMap[page].totalScroll += scroll;
                                        pageMap[page].scrollCount++;
                            }
                  });
          });

      const pages = Object.keys(pageMap)
            .sort((a, b) => pageMap[b].views - pageMap[a].views)
            .slice(0, 50)
            .map(page => ({
                      page,
                      views: pageMap[page].views,
                      avgScroll: pageMap[page].scrollCount > 0
                        ? Math.round(pageMap[page].totalScroll / pageMap[page].scrollCount)
                                  : 0
            }));

      res.json({ ok: true, pages });
    } catch (e) {
          res.status(200).json({ ok: true, error: e.message, pages: [] });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ ok: true, status: 'running', timestamp: Date.now() });
});

// Root redirect
app.get('/', (req, res) => {
    res.redirect('/admin/visitor-analytics.html');
});

app.listen(PORT, () => {
    console.log('Analytics server running on port ' + PORT);
});
