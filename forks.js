const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');

// ─── CONFIG ───────────────────────────────────────────────
const AKUN_FILE   = 'akun.txt';
const WALLET_FILE = 'wallet.txt';
const REF         = 'madsilxx';
const DELAY_MS    = 4000;
const TASK_DELAY  = 2000;
// X API
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const QUOTE_TWEET_URL = 'https://x.com/wikifork/status/2119827551610872004';
// ──────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function rl(prompt) {
  const iface = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => iface.question(prompt, ans => { iface.close(); res(ans.trim()); }));
}

function randStatusId() {
  // 19 digit, depan 2
  const rest = Array.from({length: 18}, () => Math.floor(Math.random() * 10)).join('');
  return '2' + rest;
}

function parseAkun() {
  const content = fs.readFileSync(AKUN_FILE, 'utf-8');
  const blocks = content.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map((block, i) => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error(`Akun ${i+1}: butuh authtoken + ct0`);
    return { authToken: lines[0], ct0: lines[1], index: i + 1 };
  });
}

function parseWallet() {
  if (!fs.existsSync(WALLET_FILE)) return [];
  return fs.readFileSync(WALLET_FILE, 'utf-8')
    .split('\n').map(l => l.trim()).filter(Boolean);
}

// ─── COOKIE STORE ─────────────────────────────────────────
class CookieStore {
  constructor() { this.jar = {}; }
  set(domain, str) {
    if (!this.jar[domain]) this.jar[domain] = {};
    const parts = str.split(';');
    const eq = parts[0].indexOf('=');
    if (eq < 1) return;
    const k = parts[0].slice(0, eq).trim();
    const v = parts[0].slice(eq + 1).trim();
    const skip = ['path','domain','expires','max-age','httponly','secure','samesite'];
    if (!skip.includes(k.toLowerCase())) this.jar[domain][k] = v;
  }
  get(domain) {
    return Object.entries({...this.jar['']||{}, ...this.jar[domain]||{}})
      .map(([k,v]) => `${k}=${v}`).join('; ');
  }
  ingest(headers, domain) {
    const sc = headers['set-cookie'];
    if (!sc) return;
    (Array.isArray(sc) ? sc : [sc]).forEach(c => this.set(domain, c));
  }
}

// ─── FETCH WITH REDIRECT ──────────────────────────────────
async function req(url, opts = {}, store = null, maxRedir = 5) {
  let cur = url, n = 0;
  while (n <= maxRedir) {
    const domain = new URL(cur).hostname;
    const headers = { ...opts.headers };
    if (store) {
      const jar = store.get(domain);
      if (jar) headers['Cookie'] = [headers['Cookie']||'', jar].filter(Boolean).join('; ');
    }
    const res = await fetch(cur, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
      redirect: 'manual',
    });
    if (store) store.ingest(Object.fromEntries(res.headers), domain);
    if ([301,302,303,307,308].includes(res.status) && opts.followRedirects !== false) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      cur = loc.startsWith('http') ? loc : new URL(loc, cur).href;
      n++; continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

function xHeaders(authToken, ct0, extra = {}) {
  return {
    'Authorization': `Bearer ${BEARER}`,
    'Cookie': `auth_token=${authToken}; ct0=${ct0}`,
    'X-Csrf-Token': ct0,
    'X-Twitter-Auth-Type': 'OAuth2Session',
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Client-Language': 'en',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Sec-Ch-Ua': '"Mises";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    'Sec-Ch-Ua-Mobile': '?1',
    'Sec-Ch-Ua-Platform': '"Android"',
    ...extra
  };
}

function forksHeaders(store, extra = {}) {
  return {
    'Accept': '*/*',
    'Content-Type': 'application/json',
    'Origin': 'https://forks.wiki',
    'Referer': 'https://forks.wiki/',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Sec-Ch-Ua': '"Mises";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    'Sec-Ch-Ua-Mobile': '?1',
    'Sec-Ch-Ua-Platform': '"Android"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    ...extra
  };
}

// ─── CONNECT X ────────────────────────────────────────────
async function connectX(authToken, ct0, label, store) {
  // Step 1
  const s1 = await req(
    `https://forks.wiki/auth/x/start?return=%2F%3Fresume%3Dfreeforks&ref=${REF}`,
    { followRedirects: false, headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'Referer': `https://forks.wiki/r/${REF}`,
      'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin',
    }}, store
  );
  if (s1.status !== 302) throw new Error(`Step1: ${s1.status}`);
  const authUrl = s1.headers.get('location');
  if (!authUrl?.includes('x.com')) throw new Error(`Step1 location: ${authUrl}`);

  // Step 2: GET authorize
  const s2 = await req(authUrl, {
    followRedirects: false,
    headers: xHeaders(authToken, ct0, {
      'Referer': 'https://forks.wiki/', 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site',
    })
  }, store);

  if (s2.status === 302) {
    const loc = s2.headers.get('location');
    if (loc?.includes('forks.wiki')) return await doCallback(store, loc, authToken, ct0, label);
  }
  if (s2.status !== 200) throw new Error(`Step2: ${s2.status}`);

  // Step 2b: GET auth_code dari X API
  const urlObj = new URL(authUrl);
  const apiParams = new URLSearchParams({
    response_type: urlObj.searchParams.get('response_type') || 'code',
    client_id: urlObj.searchParams.get('client_id') || '',
    redirect_uri: urlObj.searchParams.get('redirect_uri') || '',
    scope: urlObj.searchParams.get('scope') || '',
    state: urlObj.searchParams.get('state') || '',
    code_challenge: urlObj.searchParams.get('code_challenge') || '',
    code_challenge_method: urlObj.searchParams.get('code_challenge_method') || '',
  });

  const apiRes = await req(
    `https://x.com/i/api/2/oauth2/authorize?${apiParams}`,
    { followRedirects: false, headers: xHeaders(authToken, ct0, {
      'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
    })}, store
  );
  const apiJson = await apiRes.json().catch(() => null);
  const authCode = apiJson?.auth_code;
  if (!authCode) throw new Error(`auth_code gagal (${apiRes.status}): ${JSON.stringify(apiJson)}`);

  // Step 2c: POST approve
  const approveRes = await req(
    'https://x.com/i/api/2/oauth2/authorize',
    {
      method: 'POST', followRedirects: false,
      headers: xHeaders(authToken, ct0, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': authUrl, 'Origin': 'https://x.com',
        'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
      }),
      body: new URLSearchParams({ approval: 'true', code: authCode }).toString(),
    }, store
  );
  const approveJson = await approveRes.json().catch(() => null);
  const redirectUri = approveJson?.redirect_uri;
  if (!redirectUri?.includes('forks.wiki')) throw new Error(`Approve gagal (${approveRes.status}): ${JSON.stringify(approveJson)}`);

  return await doCallback(store, redirectUri, authToken, ct0, label);
}

async function doCallback(store, callbackUrl, authToken, ct0, label) {
  const res = await req(callbackUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'Referer': 'https://x.com/',
      'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site',
    }
  }, store, 5);
  if (res.status !== 200) throw new Error(`Callback: ${res.status}`);
  return true;
}

// ─── FORKS.WIKI API ───────────────────────────────────────
async function forksMe(store) {
  const r = await req('https://forks.wiki/api/me', { headers: forksHeaders(store) }, store);
  return r.json();
}

async function forksTask(store, taskId, proof = null) {
  // open
  await req('https://forks.wiki/api/task/open', {
    method: 'POST',
    headers: forksHeaders(store),
    body: JSON.stringify({ task_id: taskId }),
  }, store);

  if (['follow','like','repost'].includes(taskId)) await sleep(6000); // timer tasks

  // claim
  const body = proof ? { task_id: taskId, proof } : { task_id: taskId };
  const r = await req('https://forks.wiki/api/task/claim', {
    method: 'POST',
    headers: forksHeaders(store),
    body: JSON.stringify(body),
  }, store);
  return r.json();
}

async function forksWallet(store, wallet) {
  const r = await req('https://forks.wiki/api/wallet', {
    method: 'POST',
    headers: forksHeaders(store),
    body: JSON.stringify({ wallet }),
  }, store);
  return r.json();
}

// ─── X API: POST TWEET ────────────────────────────────────
async function postTweet(authToken, ct0, text, quoteTweetId = null) {
  // Butuh guest token / transaction ID
  // Pakai graphql CreateTweet
  const variables = {
    tweet_text: text,
    dark_request: false,
    media: { media_entities: [], possibly_sensitive: false },
    semantic_annotation_ids: [],
  };
  if (quoteTweetId) variables.quote_tweet_id = quoteTweetId;

  const r = await fetch('https://x.com/i/api/graphql/SoVnbfCycZ7fERGCwpZkYA/CreateTweet', {
    method: 'POST',
    headers: xHeaders(authToken, ct0, {
      'Content-Type': 'application/json',
      'Referer': 'https://x.com/',
      'Origin': 'https://x.com',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    }),
    body: JSON.stringify({
      variables,
      features: {
        interactive_text_enabled: true,
        longform_notetweets_inline_media_enabled: false,
        responsive_web_text_conversations_enabled: false,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: false,
        vibe_api_enabled: false,
        rweb_lists_timeline_redesign_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_timeline_navigation_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        tweetypie_unmention_optimization_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
        view_counts_everywhere_api_enabled: true,
        longform_notetweets_consumption_enabled: true,
        tweet_awards_web_tipping_enabled: false,
        freedom_of_speech_not_reach_fetch_enabled: true,
        standardized_nudges_misinfo: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        responsive_web_enhance_cards_enabled: false,
      },
      queryId: 'SoVnbfCycZ7fERGCwpZkYA',
    }),
  });

  const json = await r.json().catch(() => null);
  const tweetId = json?.data?.create_tweet?.tweet_results?.result?.rest_id;
  return { ok: !!tweetId, tweetId, raw: json };
}

// ─── MAIN FLOW PER AKUN ───────────────────────────────────
async function processAccount({ authToken, ct0, index }, wallet) {
  const label = `[Akun ${index}]`;
  const store = new CookieStore();
  store.set('x.com', `auth_token=${authToken}; ct0=${ct0}`);
  store.set('.x.com', `auth_token=${authToken}; ct0=${ct0}`);

  try {
    // 1. Connect X
    console.log(`${label} 🔗 Connect X...`);
    await connectX(authToken, ct0, label, store);
    console.log(`${label} ✓ Connected`);
    await sleep(1500);

    // 2. Get /api/me → dapat ref code & username
    const me = await forksMe(store);
    const refCode = me?.ref?.code;
    const username = me?.user?.username;
    if (!refCode) throw new Error(`Gagal dapat ref code dari /api/me`);
    console.log(`${label} ✓ Username: @${username} | Ref: ${refCode}`);
    await sleep(1000);

    // 3. Follow
    console.log(`${label} ➤ Task: follow...`);
    const rFollow = await forksTask(store, 'follow');
    console.log(`${label} ${rFollow?.ok ? '✓' : '✗'} follow | reward: ${rFollow?.reward}`);
    await sleep(TASK_DELAY);

    // 4. Like
    console.log(`${label} ➤ Task: like...`);
    const rLike = await forksTask(store, 'like');
    console.log(`${label} ${rLike?.ok ? '✓' : '✗'} like | reward: ${rLike?.reward}`);
    await sleep(TASK_DELAY);

    // 5. Repost
    console.log(`${label} ➤ Task: repost...`);
    const rRepost = await forksTask(store, 'repost');
    console.log(`${label} ${rRepost?.ok ? '✓' : '✗'} repost | reward: ${rRepost?.reward}`);
    await sleep(TASK_DELAY);

    // 6. Comment (tweet reply random ke tweet wikifork)
    console.log(`${label} ➤ Task: comment...`);
    const commentStatusId = randStatusId();
    const commentUrl = `https://x.com/${username}/status/${commentStatusId}`;
    const rComment = await forksTask(store, 'comment', commentUrl);
    console.log(`${label} ${rComment?.ok ? '✓' : '✗'} comment | reward: ${rComment?.reward}`);
    await sleep(TASK_DELAY);

    // 7. Quote tweet → tweet dulu pakai X API, ambil link, submit proof
    console.log(`${label} ➤ Task: quote...`);
    const quoteText = `my x forked into 15,000 $FORK\n\n$ git log --graph @${username}\n* x scan +9,000\n* trials +6,000\n\nwhere did yours come from?\nhttps://forks.wiki/r/${refCode} ${QUOTE_TWEET_URL}`;

    // Ambil tweet ID dari QUOTE_TWEET_URL
    const quoteTweetId = QUOTE_TWEET_URL.split('/status/')[1]?.split('?')[0];

    const tweetRes = await postTweet(authToken, ct0, quoteText, quoteTweetId);
    if (!tweetRes.ok) {
      console.log(`${label} ⚠ Quote tweet gagal: ${JSON.stringify(tweetRes.raw?.errors || tweetRes.raw)}`);
    } else {
      const proofUrl = `https://x.com/${username}/status/${tweetRes.tweetId}`;
      console.log(`${label} ✓ Quote tweeted: ${proofUrl}`);
      const rQuote = await forksTask(store, 'quote', proofUrl);
      console.log(`${label} ${rQuote?.ok ? '✓' : '✗'} quote | reward: ${rQuote?.reward}`);
    }
    await sleep(TASK_DELAY);

    // 8. Submit wallet
    if (wallet) {
      console.log(`${label} ➤ Submit wallet...`);
      const rWallet = await forksWallet(store, wallet);
      console.log(`${label} ${rWallet?.ok ? '✓' : '✗'} wallet`);
    } else {
      console.log(`${label} ⚠ Wallet tidak ada, skip`);
    }

    // 9. Final /api/me → cek allocation
    const meFinal = await forksMe(store);
    console.log(`${label} 🎉 Selesai | Allocation: ${meFinal?.allocation}`);
    return { success: true };

  } catch (err) {
    console.error(`${label} ❌ ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─── RUNNER ───────────────────────────────────────────────
async function runAccounts(accounts, wallets) {
  const results = { success: 0, failed: 0 };
  for (let i = 0; i < accounts.length; i++) {
    const wallet = wallets[accounts[i].index - 1] || null;
    const result = await processAccount(accounts[i], wallet);
    if (result.success) results.success++; else results.failed++;
    if (i < accounts.length - 1) {
      console.log(`\n  → delay ${DELAY_MS/1000}s...\n`);
      await sleep(DELAY_MS);
    }
  }
  console.log('\n═══════════════════════════════');
  console.log(`DONE: ✅ ${results.success} berhasil | ❌ ${results.failed} gagal`);
  console.log('═══════════════════════════════');
}

// ─── MENU ─────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(AKUN_FILE)) { console.error(`❌ ${AKUN_FILE} tidak ditemukan`); process.exit(1); }
  const accounts = parseAkun();
  const wallets = parseWallet();
  console.log(`\n📂 ${accounts.length} akun | 💰 ${wallets.length} wallet\n`);
  console.log('1. 1 akun\n2. Semua\n3. From X sampai end\n');

  const p = await rl('Pilihan (1/2/3): ');
  if (p === '1') {
    const n = parseInt(await rl('Nomor akun: '));
    const akun = accounts.find(a => a.index === n);
    if (!akun) { console.error('Nomor tidak valid'); process.exit(1); }
    await runAccounts([akun], wallets);
  } else if (p === '2') {
    await runAccounts(accounts, wallets);
  } else if (p === '3') {
    const n = parseInt(await rl('From nomor: '));
    const idx = accounts.findIndex(a => a.index === n);
    if (idx === -1) { console.error('Nomor tidak valid'); process.exit(1); }
    await runAccounts(accounts.slice(idx), wallets);
  } else {
    console.error('Pilihan tidak valid'); process.exit(1);
  }
}

main().catch(console.error);
