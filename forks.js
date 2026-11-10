const fs = require('fs');
const readline = require('readline');

// ─── CONFIG ───────────────────────────────────────────────
const AKUN_FILE = 'akun.txt';
const REF = 'madsilxx';
const DELAY_MS = 3000;
// ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function rl(prompt) {
  const iface = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => iface.question(prompt, ans => { iface.close(); res(ans.trim()); }));
}

function parseAkun(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const blocks = content.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map((block, i) => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error(`Akun ${i + 1}: format salah, butuh authtoken + ct0`);
    return { authToken: lines[0], ct0: lines[1], index: i + 1 };
  });
}

function makeHeaders(authToken, ct0, extra = {}) {
  return {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Sec-Ch-Ua': '"Mises";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    'Sec-Ch-Ua-Mobile': '?1',
    'Sec-Ch-Ua-Platform': '"Android"',
    'Upgrade-Insecure-Requests': '1',
    'Priority': 'u=0, i',
    ...extra
  };
}

// Simple cookie store per akun
class CookieStore {
  constructor() { this.jar = {}; }

  set(domain, cookieStr) {
    if (!this.jar[domain]) this.jar[domain] = {};
    cookieStr.split(';').forEach(part => {
      const [kv] = part.trim().split(';');
      const eq = kv.indexOf('=');
      if (eq > 0) {
        const k = kv.slice(0, eq).trim();
        const v = kv.slice(eq + 1).trim();
        if (!['path', 'domain', 'expires', 'max-age', 'httponly', 'secure', 'samesite'].includes(k.toLowerCase())) {
          this.jar[domain][k] = v;
        }
      }
    });
  }

  get(domain) {
    const cookies = { ...(this.jar[''] || {}), ...(this.jar[domain] || {}) };
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  ingestResponseHeaders(headers, domain) {
    const setCookies = headers['set-cookie'];
    if (!setCookies) return;
    const list = Array.isArray(setCookies) ? setCookies : [setCookies];
    list.forEach(c => this.set(domain, c));
  }
}

async function fetchFollow(url, options = {}, store = null, maxRedirects = 5) {
  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount <= maxRedirects) {
    const urlObj = new URL(currentUrl);
    const domain = urlObj.hostname;

    const headers = { ...options.headers };
    if (store) {
      const existing = headers['Cookie'] || headers['cookie'] || '';
      const jarCookies = store.get(domain);
      headers['Cookie'] = [existing, jarCookies].filter(Boolean).join('; ');
    }

    const res = await fetch(currentUrl, {
      method: options.method || 'GET',
      headers,
      body: options.body || undefined,
      redirect: 'manual',
    });

    if (store) store.ingestResponseHeaders(Object.fromEntries(res.headers), domain);

    if ([301, 302, 303, 307, 308].includes(res.status) && options.followRedirects !== false) {
      const location = res.headers.get('location');
      if (!location) return res;
      currentUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
      redirectCount++;
      continue;
    }

    return res;
  }
  throw new Error('Too many redirects');
}

async function connectAccount({ authToken, ct0, index }) {
  const label = `[Akun ${index}]`;
  const store = new CookieStore();

  // Inject X cookies
  store.set('x.com', `auth_token=${authToken}; ct0=${ct0}`);
  store.set('.x.com', `auth_token=${authToken}; ct0=${ct0}`);

  try {
    // ── STEP 1: forks.wiki/auth/x/start ──────────────────
    console.log(`${label} Step 1: /auth/x/start...`);
    const step1 = await fetchFollow(
      `https://forks.wiki/auth/x/start?return=%2F%3Fresume%3Dfreeforks&ref=${REF}`,
      {
        followRedirects: false,
        headers: makeHeaders(authToken, ct0, {
          'Referer': `https://forks.wiki/r/${REF}`,
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
        })
      },
      store
    );

    if (step1.status !== 302) throw new Error(`Step 1: expect 302, dapat ${step1.status}`);

    const authorizeUrl = step1.headers.get('location');
    if (!authorizeUrl?.includes('x.com')) throw new Error(`Step 1: location aneh: ${authorizeUrl}`);
    console.log(`${label} ✓ Redirect ke X OAuth`);

    // ── STEP 2: x.com/i/oauth2/authorize ─────────────────
    console.log(`${label} Step 2: Authorize di X...`);
    const step2 = await fetchFollow(
      authorizeUrl,
      {
        followRedirects: false,
        headers: makeHeaders(authToken, ct0, {
          'Cookie': `auth_token=${authToken}; ct0=${ct0}`,
          'Referer': 'https://forks.wiki/',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'cross-site',
        })
      },
      store
    );

    // Auto-approve (pernah connect sebelumnya)
    if (step2.status === 302) {
      const loc = step2.headers.get('location');
      if (loc?.includes('forks.wiki')) {
        console.log(`${label} ✓ Auto-approved`);
        return await doCallback(store, loc, authToken, ct0, label);
      }
    }

    if (step2.status !== 200) throw new Error(`Step 2: dapat ${step2.status}`);

    const html = await step2.text();
    console.log(`${label} DEBUG step2 final URL: ${step2.url}`);
    console.log(`${label} DEBUG step2 html length: ${html.length}`);
    console.log(`${label} DEBUG step2 html preview: ${html.slice(0, 300)}`);

    // Extract endpoint hints dari HTML/JS
    const endpoints = [...html.matchAll(/["'](\/i\/api\/[^"']+oauth[^"']+)["']/g)].map(m => m[1]);
    const authCodes = [...html.matchAll(/["']auth_code["']\s*:\s*["']([^"']+)["']/g)].map(m => m[1]);
    const redirects = [...html.matchAll(/["']redirect_uri["']\s*:\s*["']([^"']+)["']/g)].map(m => m[1]);
    console.log(`${label} DEBUG endpoints:`, [...new Set(endpoints)]);
    console.log(`${label} DEBUG auth_codes:`, authCodes);
    console.log(`${label} DEBUG redirects:`, redirects);

    // ── STEP 2b: Ambil auth_code via X internal API ───────
    console.log(`${label} Step 2b: Approve via X API...`);
    const urlObj = new URL(authorizeUrl);
    const state = urlObj.searchParams.get('state');

    // Extract auth_code dari HTML (embedded di JSON/script tag)
    let authCode = html.match(/"auth_code"\s*:\s*"([^"]+)"/)?.[1]
      || html.match(/auth_code=([^&"'\s]+)/)?.[1];

    if (!authCode) {
      const urlObj2 = new URL(authorizeUrl);
      const apiParams = new URLSearchParams({
        response_type: urlObj2.searchParams.get('response_type') || 'code',
        client_id: urlObj2.searchParams.get('client_id') || '',
        redirect_uri: urlObj2.searchParams.get('redirect_uri') || '',
        scope: urlObj2.searchParams.get('scope') || '',
        state: urlObj2.searchParams.get('state') || '',
        code_challenge: urlObj2.searchParams.get('code_challenge') || '',
        code_challenge_method: urlObj2.searchParams.get('code_challenge_method') || '',
      });

      const xHeaders = {
        'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
        'Cookie': `auth_token=${authToken}; ct0=${ct0}`,
        'Referer': authorizeUrl,
        'Origin': 'https://x.com',
        'X-Csrf-Token': ct0,
        'X-Twitter-Auth-Type': 'OAuth2Session',
        'X-Twitter-Active-User': 'yes',
        'X-Twitter-Client-Language': 'en',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'Sec-Ch-Ua': '"Mises";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
        'Sec-Ch-Ua-Mobile': '?1',
        'Sec-Ch-Ua-Platform': '"Android"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      };

      // Coba semua kemungkinan endpoint
      const candidates = [
        `https://x.com/i/api/2/oauth2/authorize?${apiParams}`,
        `https://api.x.com/2/oauth2/authorize?${apiParams}`,
        `https://x.com/i/api/oauth2/token?${apiParams}`,
        `https://x.com/i/oauth2/authorize?${apiParams}`,
      ];

      let apiJson = null;
      for (const endpoint of candidates) {
        const r = await fetchFollow(endpoint, { followRedirects: false, headers: xHeaders }, store);
        const txt = await r.text();
        console.log(`${label} DEBUG ${endpoint.split('?')[0]} → ${r.status}: ${txt.slice(0, 150)}`);
        try { apiJson = JSON.parse(txt); } catch {}
        if (apiJson?.auth_code) { authCode = apiJson.auth_code; break; }
        apiJson = null;
      }

      if (!authCode) {
        throw new Error(`Semua endpoint gagal, cek DEBUG di atas`);
      }
    }

    console.log(`${label} ✓ Dapat auth_code`);

    // POST approve dengan auth_code
    const approveRes = await fetchFollow(
      'https://x.com/i/api/2/oauth2/authorize',
      {
        method: 'POST',
        followRedirects: false,
        headers: {
          'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': `auth_token=${authToken}; ct0=${ct0}`,
          'Referer': authorizeUrl,
          'Origin': 'https://x.com',
          'X-Csrf-Token': ct0,
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Active-User': 'yes',
          'X-Twitter-Client-Language': 'en',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
          'Sec-Ch-Ua': '"Mises";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
          'Sec-Ch-Ua-Mobile': '?1',
          'Sec-Ch-Ua-Platform': '"Android"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: new URLSearchParams({ approval: 'true', auth_code: authCode }).toString(),
      },
      store
    );

    const approveJson = await approveRes.json().catch(() => null);
    const redirectUri = approveJson?.redirect_uri;

    if (!redirectUri?.includes('forks.wiki')) {
      throw new Error(`Approve gagal (status ${approveRes.status}): ${JSON.stringify(approveJson)}`);
    }

    return await doCallback(store, redirectUri, authToken, ct0, label);

  } catch (err) {
    console.error(`${label} ❌ ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function doCallback(store, callbackUrl, authToken, ct0, label) {
  console.log(`${label} Step 3: Callback ke forks.wiki...`);
  const res = await fetchFollow(
    callbackUrl,
    {
      headers: makeHeaders(authToken, ct0, {
        'Referer': 'https://x.com/',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
      })
    },
    store,
    5
  );

  if (res.status === 200) {
    console.log(`${label} ✅ BERHASIL!`);
    return { success: true };
  }
  throw new Error(`Callback: status ${res.status}`);
}

async function runAccounts(accounts) {
  const results = { success: 0, failed: 0 };
  for (let i = 0; i < accounts.length; i++) {
    const result = await connectAccount(accounts[i]);
    if (result.success) results.success++;
    else results.failed++;
    if (i < accounts.length - 1) {
      process.stdout.write(`  → delay ${DELAY_MS / 1000}s...\n\n`);
      await sleep(DELAY_MS);
    }
  }
  console.log('\n═══════════════════════════════');
  console.log(`DONE: ✅ ${results.success} berhasil | ❌ ${results.failed} gagal`);
  console.log('═══════════════════════════════');
}

// ─── MAIN MENU ────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(AKUN_FILE)) {
    console.error(`❌ File '${AKUN_FILE}' tidak ditemukan`);
    process.exit(1);
  }

  const accounts = parseAkun(AKUN_FILE);
  console.log(`\n📂 Loaded: ${accounts.length} akun\n`);
  console.log('Pilih mode:');
  console.log('  1. 1 akun saja');
  console.log('  2. Semua akun');
  console.log('  3. From akun X sampai end\n');

  const pilihan = await rl('Pilihan (1/2/3): ');

  if (pilihan === '1') {
    const nomor = await rl('Nomor akun: ');
    const akun = accounts.find(a => a.index === parseInt(nomor));
    if (!akun) { console.error('Nomor tidak valid'); process.exit(1); }
    await runAccounts([akun]);

  } else if (pilihan === '2') {
    await runAccounts(accounts);

  } else if (pilihan === '3') {
    const dari = await rl('From akun nomor: ');
    const startIdx = accounts.findIndex(a => a.index === parseInt(dari));
    if (startIdx === -1) { console.error('Nomor tidak valid'); process.exit(1); }
    await runAccounts(accounts.slice(startIdx));

  } else {
    console.error('Pilihan tidak valid');
    process.exit(1);
  }
}

main().catch(console.error);
