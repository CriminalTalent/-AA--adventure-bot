// ============================================================
// adventure.js — 무사수행 봇 (탐색형)
// ============================================================
import "dotenv/config";
import { createRestAPIClient, createStreamingAPIClient } from "masto";
import {
  calcSuccessRate,
  rollAdventure,
  ADVENTURE_OUTCOMES,
  calcAdventureGold,
  applyEffects,
  buildStatusLine,
  getAge,
  clamp,
} from "./game.js";
import { getPlayer, canDoAdventure, processPlayer } from "./storage.js";
import { loadMonsters, logAdventure }               from "./sheets.js";

const BOT_TOKEN    = process.env.ADVENTURE_TOKEN;
const INSTANCE_URL = process.env.MASTODON_URL;

if (!BOT_TOKEN || !INSTANCE_URL) {
  console.error(".env 설정 필요: MASTODON_URL, ADVENTURE_TOKEN");
  process.exit(1);
}

const rest      = createRestAPIClient({ url: INSTANCE_URL, accessToken: BOT_TOKEN });
const streaming = createStreamingAPIClient({
  streamingApiUrl: INSTANCE_URL.replace(/\/$/, "") + "/api/v1/streaming",
  accessToken:     BOT_TOKEN,
});

// ── 탐색 세션 ─────────────────────────────────────────────────
// { accountId -> session }
const sessions       = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(id);
  }
}

// ── 몬스터 캐시 ───────────────────────────────────────────────
let _monstersCache    = null;
let _monstersCachedAt = 0;
const CACHE_TTL_MS    = 5 * 60 * 1000;

async function getMonsters() {
  const now = Date.now();
  if (_monstersCache && now - _monstersCachedAt < CACHE_TTL_MS) return _monstersCache;
  _monstersCache    = await loadMonsters();
  _monstersCachedAt = now;
  return _monstersCache;
}

// ── 보물상자 ──────────────────────────────────────────────────
const TREASURE_TIERS = [
  { weight: 50, label: "낡은 상자",  goldMin: 50,  goldMax: 150, effects: {} },
  { weight: 35, label: "잠긴 상자",  goldMin: 100, goldMax: 300, effects: { 스트레스: -2 } },
  { weight: 15, label: "황금 상자",  goldMin: 200, goldMax: 500, effects: { 평판: 1 } },
];

function rollTreasure() {
  const roll = Math.random() * 100;
  let   acc  = 0;
  for (const tier of TREASURE_TIERS) {
    acc += tier.weight;
    if (roll < acc) {
      const gold = tier.goldMin + Math.floor(Math.random() * (tier.goldMax - tier.goldMin + 1));
      return { label: tier.label, gold, effects: tier.effects };
    }
  }
  return { label: TREASURE_TIERS[0].label, gold: 50, effects: {} };
}

// ── 이동 방향 ─────────────────────────────────────────────────
const DIR_TEXT = { 북: "북쪽", 남: "남쪽", 동: "동쪽", 서: "서쪽" };

// ── 이벤트 확률: 35% 몬스터 / 25% 보물 / 40% 안전 ────────────
function rollEvent() {
  const r = Math.random() * 100;
  if (r < 35) return "monster";
  if (r < 60) return "treasure";
  return "safe";
}

// ── 안전 내러티브 ─────────────────────────────────────────────
const SAFE_NARRATIVES = [
  "조용한 바람만 불어왔다. 발걸음을 계속 옮긴다.",
  "낙엽 소리 외에는 아무것도 없었다.",
  "멀리서 새 울음소리가 들렸다. 일단 안전하다.",
  "길이 좁아졌다가 다시 넓어졌다. 별다른 일은 없었다.",
  "수풀 사이로 햇살이 내리쬔다. 잠시 숨을 고른다.",
  "발 아래 마른 나뭇가지가 부러졌다. 조심스럽게 나아간다.",
  "안개가 짙어졌다가 이내 걷혔다. 길은 이어진다.",
];

function randomSafe() {
  return SAFE_NARRATIVES[Math.floor(Math.random() * SAFE_NARRATIVES.length)];
}

// ── 메시지 유틸 ───────────────────────────────────────────────
function parseTokens(content) {
  const plain   = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const matches = [...plain.matchAll(/\[([^\]]+)\]/g)];
  return matches.map((m) => {
    const parts = m[1].split("/");
    return { key: parts[0].trim(), value: parts[1]?.trim() ?? null };
  });
}

function splitText(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  while (text.length > 0) {
    chunks.push(text.slice(0, limit));
    text = text.slice(limit);
  }
  return chunks;
}

async function replyDM(notification, text) {
  const chunks  = splitText(text, 480);
  let   replyId = notification.status?.id;
  for (const chunk of chunks) {
    const status = await rest.v1.statuses.create({
      status:      `@${notification.account.acct} ${chunk}`,
      inReplyToId: replyId,
      visibility:  "direct",
    });
    replyId = status.id;
  }
}

async function postPublic(text) {
  await rest.v1.statuses.create({
    status:     text.slice(0, 490),
    visibility: "public",
  });
}

// ── 세션 누적 헬퍼 ────────────────────────────────────────────
function accumulateEffects(session, effects, goldDelta) {
  session.totalGold += goldDelta;
  for (const [stat, delta] of Object.entries(effects)) {
    session.totalEffects[stat] = (session.totalEffects[stat] ?? 0) + delta;
  }
}

// 세션 누적 효과를 임시 적용 (이동 중 성공률 계산용)
function applySessionEffects(player, session) {
  const stats  = { ...player.stats };
  const hidden = { ...player.hidden };
  for (const [stat, delta] of Object.entries(session.totalEffects)) {
    if (stat in stats)  stats[stat]  = clamp(stats[stat]  + delta, 0, 100);
    if (stat in hidden) hidden[stat] = clamp(hidden[stat] + delta, 0, 100);
  }
  return { ...player, stats, hidden };
}

// ── 탐색 시작 ─────────────────────────────────────────────────
async function handleStart(notification, accountId, displayName, locationFilter) {
  const ok = await canDoAdventure(accountId, displayName);
  if (!ok) {
    await replyDM(notification,
      "무사수행을 진행할 수 없습니다.\n" +
      "스케줄 봇에 [스케줄/무사수행/...]을 포함하여 제출했는지 확인해주세요."
    );
    return;
  }

  if (sessions.has(accountId)) {
    await replyDM(notification, "이미 진행 중인 탐색이 있습니다. [귀환]으로 먼저 종료해주세요.");
    return;
  }

  const player = await getPlayer(accountId, displayName);

  sessions.set(accountId, {
    displayName,
    playerSnapshot: player,
    location:       locationFilter ?? "야외",
    steps:          0,
    log:            [],
    totalGold:      0,
    totalEffects:   {},
    expiresAt:      Date.now() + SESSION_TTL_MS,
  });

  const lines = [
    `[${displayName}] 무사수행 시작 — ${locationFilter ?? "야외"}`,
    "",
    "탐색을 시작합니다. 방향을 선택해 이동하세요.",
    "",
    "[북] [남] [동] [서] — 이동",
    "[귀환] — 탐색 종료 및 결과 저장",
    "",
    `출발 전 상태 / 체력: ${player.stats.체력} / 전투: ${player.hidden.전투} / 소지금: ${player.gold}G`,
  ];

  await replyDM(notification, lines.join("\n"));
}

// ── 이동 처리 ─────────────────────────────────────────────────
async function handleMove(notification, accountId, dir) {
  cleanExpiredSessions();

  const session = sessions.get(accountId);
  if (!session) {
    await replyDM(notification, "진행 중인 탐색이 없습니다. [무사수행]으로 시작해주세요.");
    return;
  }

  session.steps    += 1;
  session.expiresAt = Date.now() + SESSION_TTL_MS;

  const player    = session.playerSnapshot;
  const monsters  = await getMonsters();
  const age       = getAge(player.turn);
  const eventType = rollEvent();

  const lines = [`[${session.steps}번째 이동 — ${DIR_TEXT[dir]}]`, ""];

  if (eventType === "monster") {
    const pool = Object.values(monsters).filter((m) => {
      const ageOk      = (m.minAge ?? 0) <= age;
      const locationOk = !session.location ||
                         session.location === "야외" ||
                         m.location === session.location;
      return ageOk && locationOk;
    });

    const monster     = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
    const tempPlayer  = applySessionEffects(player, session);
    const successRate = calcSuccessRate(tempPlayer, monster);
    const { roll, result } = rollAdventure(successRate);
    const goldDelta   = calcAdventureGold(result, monster);
    const outcome     = ADVENTURE_OUTCOMES[result];

    accumulateEffects(session, outcome.effects, goldDelta);

    const monsterName = monster?.마물명 ?? "정체불명의 적";
    lines.push(`마물 출현: ${monsterName}`);
    if (monster?.dialogue) lines.push(`"${monster.dialogue}"`);
    lines.push("");
    lines.push(...outcome.narrative(monsterName));
    lines.push("");
    lines.push(`판정: ${result} (주사위 ${roll} / 성공률 ${successRate}%)`);

    const fxParts = [
      ...Object.entries(outcome.effects).map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`),
      goldDelta !== 0 ? `골드${goldDelta > 0 ? "+" : ""}${goldDelta}G` : null,
    ].filter(Boolean);

    if (fxParts.length > 0) lines.push(`변화: ${fxParts.join(" / ")}`);

    session.log.push({ type: "monster", name: monsterName, result, goldDelta });

    // 체력 위험 체크 — 강제 귀환
    const tempAfter = applySessionEffects(player, session);
    if (tempAfter.stats.체력 <= 5) {
      lines.push("");
      lines.push("체력이 한계에 달했습니다. 강제 귀환합니다.");
      await replyDM(notification, lines.join("\n"));
      await finishAdventure(notification, accountId, true);
      return;
    }

  } else if (eventType === "treasure") {
    const chest = rollTreasure();
    accumulateEffects(session, chest.effects, chest.gold);

    lines.push(`보물 발견: ${chest.label}`);
    lines.push("");
    lines.push(`골드 +${chest.gold}G 획득`);

    if (Object.keys(chest.effects).length > 0) {
      const fxParts = Object.entries(chest.effects).map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`);
      lines.push(`추가 효과: ${fxParts.join(" / ")}`);
    }

    session.log.push({ type: "treasure", label: chest.label, goldDelta: chest.gold });

  } else {
    lines.push(randomSafe());
    session.log.push({ type: "safe" });
  }

  lines.push("");
  lines.push(`누적 골드: +${session.totalGold}G / 이동 횟수: ${session.steps}`);
  lines.push("[북] [남] [동] [서] 이동 / [귀환] 복귀");

  await replyDM(notification, lines.join("\n"));
}

// ── 귀환 ──────────────────────────────────────────────────────
async function handleReturn(notification, accountId) {
  cleanExpiredSessions();
  if (!sessions.has(accountId)) {
    await replyDM(notification, "진행 중인 탐색이 없습니다.");
    return;
  }
  await finishAdventure(notification, accountId, false);
}

async function finishAdventure(notification, accountId, forced) {
  const session = sessions.get(accountId);
  if (!session) return;
  sessions.delete(accountId);

  const updated = await processPlayer(accountId, (p) => {
    const { stats, hidden } = applyEffects(p, session.totalEffects, 0);
    const gold              = Math.max(0, p.gold + session.totalGold);

    const history = [...p.history];
    if (history.length > 0) {
      history[history.length - 1] = {
        ...history.at(-1),
        adventureResult: {
          steps:     session.steps,
          totalGold: session.totalGold,
          effects:   session.totalEffects,
          forced,
          log:       session.log,
        },
      };
    }
    return { ...p, stats, hidden, gold, history };
  });

  const monsterCount  = session.log.filter((e) => e.type === "monster").length;
  const treasureCount = session.log.filter((e) => e.type === "treasure").length;

  const fxLines = Object.entries(session.totalEffects)
    .map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`)
    .join(" / ") || "없음";

  const publicText = [
    `[${session.displayName}] 무사수행 귀환${forced ? " (강제)" : ""}`,
    `탐색 지역: ${session.location} / 이동 횟수: ${session.steps}`,
    `조우: 마물 ${monsterCount}회 / 보물 ${treasureCount}회`,
    "",
    `총 획득 골드: +${session.totalGold}G`,
    `수치 변화: ${fxLines}`,
    "",
    buildStatusLine(updated),
  ].join("\n");

  await postPublic(publicText.slice(0, 490));
  await replyDM(notification,
    `무사수행 완료. 결과가 공개 게시되었습니다.\n\n${buildStatusLine(updated)}`
  );

  await logAdventure(
    session.displayName,
    `${session.location} (${session.steps}회 탐색)`,
    forced ? "강제귀환" : "귀환",
    session.steps,
    monsterCount,
    session.totalGold,
    updated.gold
  );
}

// ── 몬스터 목록 ───────────────────────────────────────────────
async function handleMonsterList(notification, location) {
  const monsters = await getMonsters();
  const entries  = Object.entries(monsters).filter(([, m]) =>
    location ? m.location === location : true
  );

  if (entries.length === 0) {
    await replyDM(notification, location
      ? `'${location}'에 등록된 마물이 없습니다.`
      : "등록된 마물이 없습니다."
    );
    return;
  }

  const lines = entries.map(([name, m]) => {
    const goldRange = `${m.goldMin ?? 0}~${m.goldMax ?? 0}G`;
    return `${name} [${m.location ?? "-"}] HP:${m.hp} 공:${m.atk} 방:${m.def} / ${goldRange} / ${m.desc ?? ""}`;
  });

  await replyDM(notification,
    `[마물 목록${location ? ` — ${location}` : ""}]\n${lines.join("\n")}`
  );
}

// ── 명령 분기 ─────────────────────────────────────────────────
const MOVE_KEYS = new Set(["북", "남", "동", "서"]);

async function handleNotification(notification) {
  if (notification.type !== "mention")               return;
  if (!notification.status || !notification.account) return;

  const accountId   = notification.account.id;
  const acct        = notification.account.acct;
  const displayName = notification.account.displayName || acct;
  const tokens      = parseTokens(notification.status.content);

  if (tokens.length === 0) return;

  for (const token of tokens) {
    if (MOVE_KEYS.has(token.key)) {
      await handleMove(notification, accountId, token.key);
      continue;
    }

    switch (token.key) {
      case "무사수행":
        await handleStart(notification, accountId, displayName, token.value);
        break;
      case "귀환":
        await handleReturn(notification, accountId);
        break;
      case "몬스터목록":
        await handleMonsterList(notification, token.value);
        break;
      default:
        await replyDM(notification,
          "알 수 없는 명령입니다.\n[무사수행] 시작 / [북][남][동][서] 이동 / [귀환] 복귀"
        );
        break;
    }
  }
}

// ── 시작 ─────────────────────────────────────────────────────
async function main() {
  const me = await rest.v1.accounts.verifyCredentials();
  console.log("무사수행 봇 시작: @" + me.username);

  const stream = await streaming.user.subscribe();

  for await (const event of stream) {
    if (event.event !== "notification") continue;
    try {
      await handleNotification(event.payload);
      await rest.v1.notifications.dismiss({ id: event.payload.id });
    } catch (err) {
      console.error("알림 처리 오류:", err);
    }
  }
}

main().catch((err) => {
  console.error("봇 오류:", err);
  process.exit(1);
});
