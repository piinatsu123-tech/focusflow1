const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Quick Reply ボタン定義 ───────────────────────────────────────
const btn = (label, text) => ({ type: 'action', action: { type: 'message', label, text: text || label } });

const QR_DEFAULT  = { items: [btn('一覧'), btn('定期一覧'), btn('ヘルプ')] };
const QR_TASK     = { items: [btn('一覧'), btn('定期一覧'), btn('定期登録'), btn('ヘルプ')] };
const QR_RECURRING= { items: [btn('定期登録'), btn('定期削除'), btn('一覧')] };
const QR_AFTER_REG= { items: [btn('定期一覧'), btn('一覧'), btn('ヘルプ')] };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (request.method === 'GET' && url.pathname === '/tasks') {
      const tasks = await env.TASKS.get('pending', { type: 'json' }) || [];
      return new Response(JSON.stringify(tasks), { headers: { 'Content-Type': 'application/json', ...CORS } });
    }
    if (request.method === 'DELETE' && url.pathname === '/tasks') {
      await env.TASKS.put('pending', JSON.stringify([]));
      return new Response('OK', { headers: CORS });
    }
    if (request.method === 'POST' && url.pathname === '/sync') {
      const body = await request.json().catch(() => ({}));
      await env.TASKS.put('active_tasks', JSON.stringify(body.tasks || []));
      return new Response('OK', { headers: CORS });
    }
    if (request.method === 'POST' && url.pathname === '/webhook') {
      const body = await request.text();
      const signature = request.headers.get('x-line-signature');
      if (!await verifySignature(body, signature, env.LINE_CHANNEL_SECRET))
        return new Response('Unauthorized', { status: 401 });
      const data = JSON.parse(body);
      for (const event of data.events || []) {
        if (event.type !== 'message') continue;
        ctx.waitUntil(handleMessage(event, env));
      }
      return new Response('OK');
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processRecurringTasks(env));
  }
};

// ─── LINE メッセージ処理 ──────────────────────────────────────────
async function handleMessage(event, env) {
  const replyToken = event.replyToken;
  if (event.message.type !== 'text' && event.message.type !== 'image') return;
  const text = event.message.type === 'text' ? event.message.text.trim() : null;

  if (text === '一覧' || text === 'タスク一覧') return handleTaskList(replyToken, env);
  if (text === '定期一覧') return handleRecurringList(replyToken, env);
  if (text?.startsWith('定期登録 ')) return handleRecurringAdd(replyToken, text, env);
  if (text?.startsWith('定期削除 ')) return handleRecurringDelete(replyToken, text, env);
  if (text === 'ヘルプ' || text === 'help') return replyToLine(replyToken, HELP_TEXT, QR_DEFAULT, env);

  // 単体コマンド → フォーマット案内
  if (text === '定期登録') {
    return replyToLine(replyToken,
      '定期タスクの登録形式：\n定期登録 スケジュール タスク名\n\n例）\n定期登録 毎日 薬を飲む\n定期登録 毎週月曜 燃えるゴミを出す\n定期登録 毎月1日 家賃を確認する\n定期登録 3日ごと 掃除機をかける',
      QR_RECURRING, env);
  }
  if (text === '定期削除') {
    const list = await env.TASKS.get('recurring', { type: 'json' }) || [];
    const listText = list.length ? '\n\n登録中のタスク：\n' + list.map(r => `・${r.title}`).join('\n') : '';
    return replyToLine(replyToken,
      `削除形式：\n定期削除 タスク名${listText}`,
      QR_RECURRING, env);
  }

  // 通常タスク追加（Claude API）
  let userContent;
  if (event.message.type === 'text') {
    userContent = [{ type: 'text', text }];
  } else {
    const imageRes = await fetch(
      `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
      { headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN.replace(/\s/g, '')}` } }
    );
    const imageData = await imageRes.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(imageData)));
    userContent = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
      { type: 'text', text: 'この画像を見て、対処すべきことをタスクに分解してください。' }
    ];
  }

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: `あなたはタスク管理アシスタントです。ユーザーの入力からFocusFlow用のタスクJSONを生成してください。JSONのみ返してください。前置き不要。
今日の日付：${new Date().toISOString().slice(0,10)}

## ステップ分解の原則
ステップは「次に実際に手や体を動かす最小の行動」まで分解する。
「〇〇のページを開く」「〇〇に電話をかける」「〇〇を引き出しから取り出す」レベルが理想。

悪い例：「薬を買う」→ 良い例：「ドラッグストアのサイトを開く」「検索欄に薬名を入力する」「カートに入れて決済する」
悪い例：「メールを送る」→ 良い例：「メールアプリを開く」「宛先と件名を入力する」「本文を書いて送信する」
ステップ数は3〜7個が目安。

形式：
{"tasks":[{"id":"task_1","title":"タスクタイトル","urgency":"must","dueDate":"2026-05-20","steps":[{"id":"step_1","title":"具体的な行動","estimatedMinutes":5,"done":false}]}]}

urgency基準：must=今日中、want=近いうちに、nice=できれば
dueDate：期日が明示されている場合のみISO形式で設定。ない場合はフィールドごと省略。`,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  const claudeData = await claudeRes.json();
  const jsonText = claudeData.content[0].text.replace(/```json|```/g, '').trim();
  let newTasks;
  try { newTasks = JSON.parse(jsonText).tasks || []; }
  catch {
    await replyToLine(replyToken, '処理できませんでした。もう一度送ってみてください。', QR_DEFAULT, env);
    return;
  }

  const existing = await env.TASKS.get('pending', { type: 'json' }) || [];
  await env.TASKS.put('pending', JSON.stringify([...existing, ...newTasks]));
  const titles = newTasks.map(t => `・${t.title}`).join('\n');
  await replyToLine(replyToken, `✅ 追加しました！\n${titles}`, QR_TASK, env);
}

// ─── コマンド：タスク一覧 ─────────────────────────────────────────
async function handleTaskList(replyToken, env) {
  const tasks = await env.TASKS.get('active_tasks', { type: 'json' }) || [];
  const active = tasks.filter(t => !t.done);
  if (!active.length) return replyToLine(replyToken, '現在のタスクはありません。', QR_DEFAULT, env);
  const groups = { must: [], want: [], nice: [] };
  active.forEach(t => (groups[t.urgency] || groups.want).push(t.title));
  const labels = { must: '今日中に絶対', want: 'できたらやりたい', nice: '余力があれば' };
  let msg = '📋 現在のタスク一覧\n';
  for (const [key, label] of Object.entries(labels)) {
    if (groups[key].length) msg += `\n【${label}】\n` + groups[key].map(t => `・${t}`).join('\n') + '\n';
  }
  await replyToLine(replyToken, msg.trim(), QR_DEFAULT, env);
}

// ─── コマンド：定期タスク管理 ────────────────────────────────────
async function handleRecurringList(replyToken, env) {
  const list = await env.TASKS.get('recurring', { type: 'json' }) || [];
  if (!list.length) return replyToLine(replyToken,
    '定期タスクはまだ登録されていません。\n\n「定期登録」をタップして登録できます。',
    { items: [btn('定期登録'), btn('ヘルプ')] }, env);
  const msg = '🔁 定期タスク一覧\n\n' + list.map(r => `・${r.schedule}　${r.title}`).join('\n');
  await replyToLine(replyToken, msg, QR_RECURRING, env);
}

async function handleRecurringAdd(replyToken, text, env) {
  const parts = text.replace('定期登録 ', '').trim().split(' ');
  if (parts.length < 2) return replyToLine(replyToken,
    '形式：定期登録 スケジュール タスク名\n例：定期登録 3日ごと 掃除機をかける',
    QR_RECURRING, env);
  const schedule = parts[0];
  const title = parts.slice(1).join(' ');
  if (!isValidSchedule(schedule)) return replyToLine(replyToken,
    `スケジュールの形式が正しくありません。\n使える形式：\n・毎日\n・毎週月曜\n・毎月1日\n・3日ごと / 3日に1回 / 毎3日`,
    QR_RECURRING, env);
  const today = jstDateStr();
  const list = await env.TASKS.get('recurring', { type: 'json' }) || [];
  list.push({ id: `rec_${Date.now()}`, title, schedule, urgency: 'want', lastAdded: today });
  await env.TASKS.put('recurring', JSON.stringify(list));
  await replyToLine(replyToken, `✅ 定期タスクを登録しました\n「${title}」（${schedule}）`, QR_AFTER_REG, env);
}

async function handleRecurringDelete(replyToken, text, env) {
  const title = text.replace('定期削除 ', '').trim();
  const list = await env.TASKS.get('recurring', { type: 'json' }) || [];
  const newList = list.filter(r => r.title !== title);
  if (newList.length === list.length) return replyToLine(replyToken,
    `「${title}」は見つかりませんでした。「定期一覧」で確認できます。`,
    QR_RECURRING, env);
  await env.TASKS.put('recurring', JSON.stringify(newList));
  await replyToLine(replyToken, `🗑 「${title}」を定期タスクから削除しました。`, QR_AFTER_REG, env);
}

// ─── Cron：定期タスクをpendingに追加 ─────────────────────────────
async function processRecurringTasks(env) {
  const list = await env.TASKS.get('recurring', { type: 'json' }) || [];
  if (!list.length) return;
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayStr = jstDateStr(now);
  let changed = false;
  const toAdd = [];
  for (const r of list) {
    if (matchesSchedule(r.schedule, now, r.lastAdded)) {
      toAdd.push(r);
      r.lastAdded = todayStr;
      changed = true;
    }
  }
  if (changed) await env.TASKS.put('recurring', JSON.stringify(list));
  if (!toAdd.length) return;
  const newTasks = toAdd.map(r => ({
    id: `rec_${r.id}_${todayStr}`,
    title: r.title, urgency: r.urgency || 'want',
    steps: [], done: false, createdAt: now.toISOString()
  }));
  const pending = await env.TASKS.get('pending', { type: 'json' }) || [];
  await env.TASKS.put('pending', JSON.stringify([...pending, ...newTasks]));
}

// ─── スケジュール判定 ─────────────────────────────────────────────
const DAY_MAP = { '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6, '日': 0 };

function parseInterval(s) {
  const m = s.match(/^(?:毎(\d+)日|(\d+)日(?:ごと|に1回))$/);
  return m ? parseInt(m[1] || m[2]) : null;
}

function isValidSchedule(s) {
  if (s === '毎日') return true;
  if (s.startsWith('毎週')) { const d = s.replace('毎週', '').replace(/曜日?/, ''); return d in DAY_MAP; }
  if (s.startsWith('毎月')) { const n = parseInt(s.replace('毎月', '').replace('日', '')); return n >= 1 && n <= 31; }
  return parseInterval(s) !== null;
}

function matchesSchedule(schedule, now, lastAdded) {
  if (schedule === '毎日') return true;
  if (schedule.startsWith('毎週')) {
    const d = schedule.replace('毎週', '').replace(/曜日?/, '');
    return now.getDay() === DAY_MAP[d];
  }
  if (schedule.startsWith('毎月')) {
    const n = parseInt(schedule.replace('毎月', '').replace('日', ''));
    return now.getDate() === n;
  }
  const interval = parseInterval(schedule);
  if (interval !== null) {
    if (!lastAdded) return true;
    const last = new Date(lastAdded + 'T00:00:00+09:00');
    return Math.floor((now - last) / 86400000) >= interval;
  }
  return false;
}

function jstDateStr(date) {
  const d = date || new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ─── ヘルプ ──────────────────────────────────────────────────────
const HELP_TEXT = `📖 使い方

【タスク追加】
テキストや画像をそのまま送る

【確認】
一覧 → 現在のタスク一覧
定期一覧 → 定期タスク一覧

【定期タスク登録】
定期登録 毎日 タスク名
定期登録 毎週月曜 タスク名
定期登録 毎月1日 タスク名
定期登録 3日ごと タスク名
定期登録 3日に1回 タスク名
定期削除 タスク名`;

// ─── LINE返信（Quick Reply対応） ─────────────────────────────────
async function replyToLine(replyToken, text, quickReply, env) {
  const message = { type: 'text', text };
  if (quickReply) message.quickReply = quickReply;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN.replace(/\s/g, '')}` },
    body: JSON.stringify({ replyToken, messages: [message] })
  });
}

// ─── 署名検証 ────────────────────────────────────────────────────
async function verifySignature(body, signature, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig))) === signature;
}
