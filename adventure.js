// ============================================================
// adventure.js — 무사수행 봇 (탐색형 / 구역+방향 풍경)
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

// ── 구역 정의 ─────────────────────────────────────────────────
// steps 기준으로 구역 전환
// monsterRate / treasureRate / safeRate 합계 = 100

const ZONES = [
  {
    label:       "입구",
    desc:        "탐색의 시작점. 길이 비교적 잘 정비되어 있다.",
    minStep:     1,
    maxStep:     3,
    monsterRate: 25,
    treasureRate: 20,
    treasureTier: "low",
  },
  {
    label:       "외곽",
    desc:        "사람의 흔적이 드물어진다. 풀숲이 무성하다.",
    minStep:     4,
    maxStep:     6,
    monsterRate: 35,
    treasureRate: 25,
    treasureTier: "mid",
  },
  {
    label:       "폐허",
    desc:        "무너진 건물 잔해가 곳곳에 흩어져 있다. 불길한 기운이 느껴진다.",
    minStep:     7,
    maxStep:     9,
    monsterRate: 45,
    treasureRate: 28,
    treasureTier: "mid",
  },
  {
    label:       "심부",
    desc:        "공기가 무겁게 가라앉아 있다. 여기까지 들어온 자는 드물다.",
    minStep:     10,
    maxStep:     Infinity,
    monsterRate: 55,
    treasureRate: 30,
    treasureTier: "high",
  },
];

function getZone(steps) {
  return ZONES.find((z) => steps >= z.minStep && steps <= z.maxStep) ?? ZONES.at(-1);
}

// ── 방향별 풍경 문장 ──────────────────────────────────────────
const SCENERY = {
  북: [
    "경사가 서서히 가팔라진다.",
    "찬 바람이 정면으로 불어온다.",
    "발 아래 돌이 많아진다.",
    "나무가 드문드문 서 있다.",
    "먼 곳에 산등성이가 보인다.",
  ],
  남: [
    "길이 완만하게 넓어진다.",
    "따뜻한 햇살이 등 뒤로 내리쬔다.",
    "풀밭이 펼쳐지며 발걸음이 가벼워진다.",
    "멀리서 물소리가 희미하게 들린다.",
    "바람이 잦아들며 공기가 고요해진다.",
  ],
  동: [
    "나무들이 점점 빽빽해진다.",
    "새 소리가 점차 멀어진다.",
    "이끼가 발에 밟히기 시작한다.",
    "햇빛이 나뭇가지 사이로 비집고 든다.",
    "좁은 샛길이 이어진다.",
  ],
  서: [
    "옅은 안개가 발목을 감싼다.",
    "낡은 돌길이 나타난다.",
    "낡은 표지판이 보이지만 글씨를 읽을 수 없다.",
    "습한 공기가 옷깃을 적신다.",
    "그림자가 길게 드리운다.",
  ],
};

function randomScenery(dir) {
  const pool = SCENERY[dir] ?? [];
  return pool[Math.floor(Math.random() * pool.length)] ?? "";
}

// ── 보물상자 등급 ─────────────────────────────────────────────
const TREASURE_POOL = {
  low: [
    { label: "낡은 나무 상자", weight: 70, goldMin: 30,  goldMax: 100, effects: {} },
    { label: "녹슨 철제 상자", weight: 30, goldMin: 80,  goldMax: 180, effects: { 스트레스: -1 } },
  ],
  mid: [
    { label: "잠긴 가죽 상자", weight: 60, goldMin: 100, goldMax: 250, effects: { 스트레스: -2 } },
    { label: "문양이 새겨진 상자", weight: 40, goldMin: 200, goldMax: 350, effects: { 평판: 1 } },
  ],
  high: [
    { label: "황금 문양 상자",  weight: 55, goldMin: 250, goldMax: 450, effects: { 평판: 1, 스트레스: -2 } },
    { label: "마력이 깃든 상자", weight: 45, goldMin: 350, goldMax: 600, effects: { 야망: 1, 평판: 2 } },
  ],
};

function rollTreasure(tier) {
  const pool = TREASURE_POOL[tier] ?? TREASURE_POOL.low;
  const total = pool.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of pool) {
    r -= t.weight;
    if (r <= 0) {
      const gold = t.goldMin + Math.floor(Math.random() * (t.goldMax - t.goldMin + 1));
      return { label: t.label, gold, effects: t.effects };
    }
  }
  const t = pool[0];
  return { label: t.label, gold: t.goldMin, effects: t.effects };
}

// ── 이벤트 판정 ───────────────────────────────────────────────
function rollEvent(zone) {
  const r = Math.random() * 100;
  if (r < zone.monsterRate)                          return "monster";
  if (r < zone.monsterRate + zone.treasureRate)      return "treasure";
  return "safe";
}

// ── 안전 내러티브 ─────────────────────────────────────────────
const SAFE_NARRATIVES = [
  "조용한 바람만 불어왔다.",
  "낙엽 소리 외에는 아무것도 없었다.",
  "멀리서 새 울음소리가 들렸다. 일단 안전하다.",
  "수풀 사이로 햇살이 내리쬔다. 잠시 숨을 고른다.",
  "발 아래 마른 나뭇가지가 부러졌다. 조심스럽게 나아간다.",
  "안개가 짙어졌다가 이내 걷혔다. 길은 이어진다.",
  "바람에 나뭇잎이 흩날렸다. 별다른 일은 없었다.",
];

function randomSafe() {
  return SAFE_NARRATIVES[Math.floor(Math.random() * SAFE_NARRATIVES.length)];
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

// ── 세션 관리 ─────────────────────────────────────────────────
const sessions       = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(id);
  }
}

function accumulateEffects(session, effects, goldDelta) {
  session.totalGold += goldDelta;
  for (const [stat, delta] of Object.entries(effects)) {
    session.totalEffects[stat] = (session.totalEffects[stat] ?? 0) + delta;
  }
}

function applySessionEffects(player, session) {
  const stats  = { ...player.stats };
  const hidden = { ...player.hidden };
  for (const [stat, delta] of Object.entries(session.totalEffects)) {
    if (stat in stats)  stats[stat]  = clamp(stats[stat]  + delta, 0, 100);
    if (stat in hidden) hidden[stat] = clamp(hidden[stat] + delta, 0, 100);
  }
  return { ...player, stats, hidden };
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

  const player    = await getPlayer(accountId, displayName);
  const startZone = ZONES[0];

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
    `현재 구역: ${startZone.label}`,
    startZone.desc,
    "",
    `출발 전 상태 / 체력: ${player.stats.체력} / 전투: ${player.hidden.전투} / 소지금: ${player.gold}G`,
    "",
    "[북] [남] [동] [서] 이동 / [귀환] 탐색 종료",
  ];

  await replyDM(notification, lines.join("\n"));
}

// ── 이동 처리 ─────────────────────────────────────────────────
const DIR_TEXT = { 북: "북쪽", 남: "남쪽", 동: "동쪽", 서: "서쪽" };

async function handleMove(notification, accountId, dir) {
  cleanExpiredSessions();

  const session = sessions.get(accountId);
  if (!session) {
    await replyDM(notification, "진행 중인 탐색이 없습니다. [무사수행]으로 시작해주세요.");
    return;
  }

  session.steps    += 1;
  session.expiresAt = Date.now() + SESSION_TTL_MS;

  const zone      = getZone(session.steps);
  const prevZone  = getZone(session.steps - 1);
  const zoneChanged = zone.label !== prevZone.label;

  const player    = session.playerSnapshot;
  const monsters  = await getMonsters();
  const age       = getAge(player.turn);
  const eventType = rollEvent(zone);

  const lines = [
    `[${DIR_TEXT[dir]} / ${session.steps}번째 이동]`,
    randomScenery(dir),
  ];

  // 구역 전환 알림
  if (zoneChanged) {
    lines.push("");
    lines.push(`--- 구역 전환: ${zone.label} ---`);
    lines.push(zone.desc);
  }

  lines.push("");

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

    const tempAfter = applySessionEffects(player, session);
    if (tempAfter.stats.체력 <= 5) {
      lines.push("");
      lines.push("체력이 한계에 달했습니다. 강제 귀환합니다.");
      await replyDM(notification, lines.join("\n"));
      await finishAdventure(notification, accountId, true);
      return;
    }

  } else if (eventType === "treasure") {
    const chest = rollTreasure(zone.treasureTier);
    accumulateEffects(session, chest.effects, chest.gold);

    lines.push(`보물 발견: ${chest.label}`);
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
  lines.push(`현재 구역: ${zone.label} / 이동 ${session.steps}회 / 누적 골드 +${session.totalGold}G`);
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
  const finalZone     = getZone(session.steps);

  const fxLines = Object.entries(session.totalEffects)
    .map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`)
    .join(" / ") || "없음";

  const publicText = [
    `[${session.displayName}] 무사수행 귀환${forced ? " (강제)" : ""}`,
    `탐색 지역: ${session.location} / 최종 구역: ${finalZone.label} / 이동 ${session.steps}회`,
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
    `${session.location} / ${finalZone.label} (${session.steps}회)`,
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
