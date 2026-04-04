// ============================================================
// adventure.js — 무사수행 봇 (솔로 퍼블릭 + 레이드)
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

const BOT_TOKEN        = process.env.ADVENTURE_TOKEN;
const INSTANCE_URL     = process.env.MASTODON_URL;
const MAX_RAID_MEMBERS = Number(process.env.MAX_RAID_MEMBERS ?? 4);

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
const ZONES = [
  {
    label:        "입구",
    desc:         "탐색의 시작점. 길이 비교적 잘 정비되어 있다.",
    minStep:      1,
    maxStep:      3,
    monsterRate:  25,
    treasureRate: 20,
    treasureTier: "low",
  },
  {
    label:        "외곽",
    desc:         "사람의 흔적이 드물어진다. 풀숲이 무성하다.",
    minStep:      4,
    maxStep:      6,
    monsterRate:  35,
    treasureRate: 25,
    treasureTier: "mid",
  },
  {
    label:        "폐허",
    desc:         "무너진 건물 잔해가 곳곳에 흩어져 있다. 불길한 기운이 느껴진다.",
    minStep:      7,
    maxStep:      9,
    monsterRate:  45,
    treasureRate: 28,
    treasureTier: "mid",
  },
  {
    label:        "심부",
    desc:         "공기가 무겁게 가라앉아 있다. 여기까지 들어온 자는 드물다.",
    minStep:      10,
    maxStep:      Infinity,
    monsterRate:  55,
    treasureRate: 30,
    treasureTier: "high",
  },
];

function getZone(steps) {
  return ZONES.find((z) => steps >= z.minStep && steps <= z.maxStep) ?? ZONES.at(-1);
}

// ── 방향별 풍경 ───────────────────────────────────────────────
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

// ── 보물상자 ──────────────────────────────────────────────────
const TREASURE_POOL = {
  low: [
    { label: "낡은 나무 상자",   weight: 70, goldMin: 30,  goldMax: 100, effects: {} },
    { label: "녹슨 철제 상자",   weight: 30, goldMin: 80,  goldMax: 180, effects: { 스트레스: -1 } },
  ],
  mid: [
    { label: "잠긴 가죽 상자",    weight: 60, goldMin: 100, goldMax: 250, effects: { 스트레스: -2 } },
    { label: "문양이 새겨진 상자", weight: 40, goldMin: 200, goldMax: 350, effects: { 평판: 1 } },
  ],
  high: [
    { label: "황금 문양 상자",    weight: 55, goldMin: 250, goldMax: 450, effects: { 평판: 1, 스트레스: -2 } },
    { label: "마력이 깃든 상자",  weight: 45, goldMin: 350, goldMax: 600, effects: { 야망: 1, 평판: 2 } },
  ],
};

function rollTreasure(tier) {
  const pool  = TREASURE_POOL[tier] ?? TREASURE_POOL.low;
  const total = pool.reduce((s, t) => s + t.weight, 0);
  let   r     = Math.random() * total;
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
  if (r < zone.monsterRate)                     return "monster";
  if (r < zone.monsterRate + zone.treasureRate) return "treasure";
  return "safe";
}

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

// ── 세션 / 레이드 관리 ────────────────────────────────────────
// sessions:       accountId(솔로) | leaderId(레이드) -> session
// pendingRaids:   leaderId -> 모집 중 레이드
// memberToLeader: 멤버 accountId -> leaderId

const sessions       = new Map();
const pendingRaids   = new Map();
const memberToLeader = new Map();

const SESSION_TTL_MS = 30 * 60 * 1000;
const RAID_WAIT_TTL  = 10 * 60 * 1000;

function cleanExpired() {
  const now = Date.now();
  for (const [id, s] of sessions)    { if (s.expiresAt < now) sessions.delete(id); }
  for (const [id, r] of pendingRaids) {
    if (r.expiresAt < now) {
      for (const m of r.members) memberToLeader.delete(m.accountId);
      pendingRaids.delete(id);
    }
  }
}

// ── 세션 효과 누적 / 임시 적용 ───────────────────────────────
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

// 레이드 성공률: 멤버 전체 평균
function calcRaidSuccessRate(session, monster) {
  const rates = session.members.map((m) => {
    const temp = applySessionEffects(m.playerSnapshot, session);
    return calcSuccessRate(temp, monster);
  });
  const avg = Math.floor(rates.reduce((a, b) => a + b, 0) / rates.length);
  return clamp(avg, 10, 85);
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

async function postPublic(text, inReplyToId = null) {
  const status = await rest.v1.statuses.create({
    status:      text.slice(0, 490),
    visibility:  "public",
    inReplyToId: inReplyToId ?? undefined,
  });
  return status.id;
}

async function postUnlisted(acct, text, inReplyToId = null) {
  const status = await rest.v1.statuses.create({
    status:      `@${acct} ${text}`.slice(0, 490),
    visibility:  "unlisted",
    inReplyToId: inReplyToId ?? undefined,
  });
  return status.id;
}

// ── 솔로 시작 ─────────────────────────────────────────────────
async function handleSoloStart(notification, accountId, displayName, acct, locationFilter) {
  const ok = await canDoAdventure(accountId, displayName);
  if (!ok) {
    await replyDM(notification,
      "무사수행을 진행할 수 없습니다.\n" +
      "스케줄 봇에 [스케줄/무사수행/...]을 포함하여 제출했는지 확인해주세요."
    );
    return;
  }

  if (sessions.has(accountId) || memberToLeader.has(accountId)) {
    await replyDM(notification, "이미 진행 중인 탐색이 있습니다. [귀환]으로 먼저 종료해주세요.");
    return;
  }

  const player    = await getPlayer(accountId, displayName);
  const startZone = ZONES[0];

  sessions.set(accountId, {
    type:           "solo",
    accountId,
    displayName,
    acct,
    playerSnapshot: player,
    location:       locationFilter ?? "야외",
    steps:          0,
    log:            [],
    totalGold:      0,
    totalEffects:   {},
    threadId:       null,
    expiresAt:      Date.now() + SESSION_TTL_MS,
  });

  const text = [
    `[${displayName}] 무사수행 시작 — ${locationFilter ?? "야외"}`,
    "",
    `현재 구역: ${startZone.label}`,
    startZone.desc,
    "",
    `체력: ${player.stats.체력} / 전투: ${player.hidden.전투} / 소지금: ${player.gold}G`,
    "",
    "[북] [남] [동] [서] 이동 / [귀환] 탐색 종료",
  ].join("\n");

  const id = await postUnlisted(acct, text);
  sessions.get(accountId).threadId = id;
}

// ── 레이드 개설 ───────────────────────────────────────────────
async function handleRaidOpen(notification, accountId, displayName, acct, bossName) {
  const ok = await canDoAdventure(accountId, displayName);
  if (!ok) {
    await replyDM(notification,
      "무사수행을 진행할 수 없습니다.\n" +
      "스케줄 봇에 [스케줄/무사수행/...]을 포함하여 제출했는지 확인해주세요."
    );
    return;
  }

  if (sessions.has(accountId) || pendingRaids.has(accountId) || memberToLeader.has(accountId)) {
    await replyDM(notification, "이미 진행 중이거나 모집 중인 탐색이 있습니다.");
    return;
  }

  const player = await getPlayer(accountId, displayName);

  pendingRaids.set(accountId, {
    leaderId:    accountId,
    leaderName:  displayName,
    leaderAcct:  acct,
    bossName:    bossName ?? null,
    members:     [{ accountId, displayName, acct, playerSnapshot: player }],
    expiresAt:   Date.now() + RAID_WAIT_TTL,
  });

  memberToLeader.set(accountId, accountId);

  const text = [
    `[레이드 모집] ${displayName} 파티장`,
    bossName ? `목표 마물: ${bossName}` : "목표 마물: 랜덤",
    "",
    `참가 방법: @무사수행봇 [참가] 멘션`,
    `최대 ${MAX_RAID_MEMBERS}명 / 10분 내 모집`,
    "",
    `현재 참가자 (1/${MAX_RAID_MEMBERS}): ${displayName}`,
    "",
    "파티장이 [출발]을 입력하면 탐색 시작",
  ].join("\n");

  await postPublic(text);
}

// ── 레이드 참가 ───────────────────────────────────────────────
async function handleRaidJoin(notification, accountId, displayName, acct) {
  cleanExpired();

  const ok = await canDoAdventure(accountId, displayName);
  if (!ok) {
    await replyDM(notification,
      "무사수행을 진행할 수 없습니다.\n" +
      "스케줄 봇에 [스케줄/무사수행/...]을 포함하여 제출했는지 확인해주세요."
    );
    return;
  }

  if (memberToLeader.has(accountId) || sessions.has(accountId)) {
    await replyDM(notification, "이미 참가 중인 탐색이 있습니다.");
    return;
  }

  // 참가 가능한 레이드 찾기 (가장 최근 모집)
  const raid = [...pendingRaids.values()].find(
    (r) => r.members.length < MAX_RAID_MEMBERS && r.expiresAt > Date.now()
  );

  if (!raid) {
    await replyDM(notification, "참가 가능한 레이드가 없습니다. 파티장이 [레이드]로 먼저 모집해야 합니다.");
    return;
  }

  const player = await getPlayer(accountId, displayName);
  raid.members.push({ accountId, displayName, acct, playerSnapshot: player });
  memberToLeader.set(accountId, raid.leaderId);

  const memberNames = raid.members.map((m) => m.displayName).join(", ");

  const text = [
    `[레이드 모집] ${raid.leaderName} 파티`,
    raid.bossName ? `목표 마물: ${raid.bossName}` : "목표 마물: 랜덤",
    "",
    `현재 참가자 (${raid.members.length}/${MAX_RAID_MEMBERS}): ${memberNames}`,
    "",
    "파티장이 [출발]을 입력하면 탐색 시작",
  ].join("\n");

  await postPublic(text);
}

// ── 레이드 출발 ───────────────────────────────────────────────
async function handleRaidDepart(notification, accountId) {
  cleanExpired();

  const raid = pendingRaids.get(accountId);
  if (!raid) {
    await replyDM(notification, "모집 중인 레이드가 없습니다. [레이드]로 먼저 개설해주세요.");
    return;
  }

  if (raid.leaderId !== accountId) {
    await replyDM(notification, "파티장만 출발할 수 있습니다.");
    return;
  }

  pendingRaids.delete(accountId);

  const startZone = ZONES[0];

  sessions.set(accountId, {
    type:         "raid",
    leaderId:     accountId,
    leaderAcct:   raid.leaderAcct,
    bossName:     raid.bossName,
    members:      raid.members,
    steps:        0,
    log:          [],
    totalGold:    0,
    totalEffects: {},
    threadId:     null,
    expiresAt:    Date.now() + SESSION_TTL_MS,
  });

  const memberNames = raid.members.map((m) => m.displayName).join(", ");

  const text = [
    `[레이드 출발] ${raid.leaderName} 파티`,
    raid.bossName ? `목표 마물: ${raid.bossName}` : "목표 마물: 랜덤",
    `참가자: ${memberNames}`,
    "",
    `현재 구역: ${startZone.label}`,
    startZone.desc,
    "",
    "파티장이 [북][남][동][서]로 이동 / [귀환]으로 종료",
  ].join("\n");

  const id = await postPublic(text);
  sessions.get(accountId).threadId = id;
}

// ── 이동 (솔로 / 레이드 공용) ────────────────────────────────
const DIR_TEXT = { 북: "북쪽", 남: "남쪽", 동: "동쪽", 서: "서쪽" };

async function handleMove(notification, accountId, dir) {
  cleanExpired();

  // 세션 탐색: 본인이 리더인 경우 or 솔로
  let session   = sessions.get(accountId);
  let leaderId  = accountId;

  // 레이드 멤버인 경우 리더 세션 참조
  if (!session && memberToLeader.has(accountId)) {
    leaderId = memberToLeader.get(accountId);
    session  = sessions.get(leaderId);
  }

  if (!session) {
    await replyDM(notification, "진행 중인 탐색이 없습니다. [무사수행] 또는 [레이드]로 시작해주세요.");
    return;
  }

  // 레이드는 파티장만 이동
  if (session.type === "raid" && accountId !== session.leaderId) {
    await replyDM(notification, "레이드 이동은 파티장만 할 수 있습니다.");
    return;
  }

  session.steps    += 1;
  session.expiresAt = Date.now() + SESSION_TTL_MS;

  const zone      = getZone(session.steps);
  const prevZone  = getZone(session.steps - 1);
  const zoneChanged = zone.label !== prevZone.label;

  const monsters  = await getMonsters();
  const eventType = rollEvent(zone);

  const lines = [
    session.type === "raid"
      ? `[레이드 / ${DIR_TEXT[dir]} / ${session.steps}번째 이동]`
      : `[${DIR_TEXT[dir]} / ${session.steps}번째 이동]`,
    randomScenery(dir),
  ];

  if (zoneChanged) {
    lines.push("", `--- 구역 전환: ${zone.label} ---`, zone.desc);
  }

  lines.push("");

  if (eventType === "monster") {
    // 마물 결정
    let monster = null;

    if (session.type === "raid" && session.bossName) {
      monster = monsters[session.bossName] ?? null;
    } else {
      const refPlayer = session.type === "solo"
        ? session.playerSnapshot
        : session.members[0].playerSnapshot;
      const age = getAge(refPlayer.turn);

      const pool = Object.values(monsters).filter((m) => (m.minAge ?? 0) <= age);
      if (pool.length > 0) monster = pool[Math.floor(Math.random() * pool.length)];
    }

    // 성공률 계산
    const successRate = session.type === "raid"
      ? calcRaidSuccessRate(session, monster)
      : calcSuccessRate(applySessionEffects(session.playerSnapshot, session), monster);

    const { roll, result } = rollAdventure(successRate);
    const goldDelta        = calcAdventureGold(result, monster);
    const outcome          = ADVENTURE_OUTCOMES[result];

    // 레이드: 골드는 인원수로 나눔, 효과는 동일 적용
    const memberCount  = session.type === "raid" ? session.members.length : 1;
    const goldPerMember = Math.floor(goldDelta / memberCount);

    accumulateEffects(session, outcome.effects, goldDelta);

    const monsterName = monster?.마물명 ?? "정체불명의 적";
    lines.push(`마물 출현: ${monsterName}`);
    if (monster?.dialogue) lines.push(`"${monster.dialogue}"`);
    lines.push("", ...outcome.narrative(monsterName), "");
    lines.push(`판정: ${result} (주사위 ${roll} / 성공률 ${successRate}%)`);

    const fxParts = [
      ...Object.entries(outcome.effects).map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`),
      goldDelta !== 0
        ? session.type === "raid"
          ? `골드 ${goldPerMember > 0 ? "+" : ""}${goldPerMember}G (1인당)`
          : `골드${goldDelta > 0 ? "+" : ""}${goldDelta}G`
        : null,
    ].filter(Boolean);

    if (fxParts.length > 0) lines.push(`변화: ${fxParts.join(" / ")}`);
    session.log.push({ type: "monster", name: monsterName, result, goldDelta });

    // 체력 위험 체크 (솔로)
    if (session.type === "solo") {
      const tempAfter = applySessionEffects(session.playerSnapshot, session);
      if (tempAfter.stats.체력 <= 5) {
        lines.push("", "체력이 한계에 달했습니다. 강제 귀환합니다.");
        await postWithThread(session, lines.join("\n"));
        await finishSession(notification, leaderId, true);
        return;
      }
    }

  } else if (eventType === "treasure") {
    const chest       = rollTreasure(zone.treasureTier);
    const memberCount = session.type === "raid" ? session.members.length : 1;
    const goldPer     = Math.floor(chest.gold / memberCount);

    accumulateEffects(session, chest.effects, chest.gold);

    lines.push(`보물 발견: ${chest.label}`);
    lines.push(
      session.type === "raid"
        ? `골드 +${goldPer}G 획득 (1인당 / 총 ${chest.gold}G)`
        : `골드 +${chest.gold}G 획득`
    );

    if (Object.keys(chest.effects).length > 0) {
      lines.push(`추가 효과: ${Object.entries(chest.effects).map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`).join(" / ")}`);
    }

    session.log.push({ type: "treasure", label: chest.label, goldDelta: chest.gold });

  } else {
    lines.push(randomSafe());
    session.log.push({ type: "safe" });
  }

  lines.push("");
  lines.push(`현재 구역: ${zone.label} / 이동 ${session.steps}회 / 누적 골드 +${session.totalGold}G`);
  lines.push("[북] [남] [동] [서] 이동 / [귀환] 복귀");

  await postWithThread(session, lines.join("\n"));
}

// ── 스레드 게시 헬퍼 ─────────────────────────────────────────
async function postWithThread(session, text) {
  if (session.type === "solo") {
    const id = await postUnlisted(session.acct, text, session.threadId);
    session.threadId = id;
  } else {
    const id = await postPublic(text, session.threadId);
    session.threadId = id;
  }
}

// ── 귀환 ──────────────────────────────────────────────────────
async function handleReturn(notification, accountId) {
  cleanExpired();

  let leaderId = accountId;
  if (!sessions.has(accountId) && memberToLeader.has(accountId)) {
    leaderId = memberToLeader.get(accountId);
  }

  const session = sessions.get(leaderId);
  if (!session) {
    await replyDM(notification, "진행 중인 탐색이 없습니다.");
    return;
  }

  if (session.type === "raid" && accountId !== session.leaderId) {
    await replyDM(notification, "레이드 귀환은 파티장만 할 수 있습니다.");
    return;
  }

  await finishSession(notification, leaderId, false);
}

async function finishSession(notification, leaderId, forced) {
  const session = sessions.get(leaderId);
  if (!session) return;

  sessions.delete(leaderId);

  const monsterCount  = session.log.filter((e) => e.type === "monster").length;
  const treasureCount = session.log.filter((e) => e.type === "treasure").length;
  const finalZone     = getZone(Math.max(session.steps, 1));

  const fxLines = Object.entries(session.totalEffects)
    .map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`)
    .join(" / ") || "없음";

  if (session.type === "solo") {
    // 솔로 종료
    memberToLeader.delete(session.accountId);

    const updated = await processPlayer(session.accountId, (p) => {
      const { stats, hidden } = applyEffects(p, session.totalEffects, 0);
      const gold              = Math.max(0, p.gold + session.totalGold);
      const history           = [...p.history];
      if (history.length > 0) {
        history[history.length - 1] = {
          ...history.at(-1),
          adventureResult: { steps: session.steps, totalGold: session.totalGold, effects: session.totalEffects, forced, log: session.log },
        };
      }
      return { ...p, stats, hidden, gold, history };
    });

    const text = [
      `[${session.displayName}] 무사수행 귀환${forced ? " (강제)" : ""}`,
      `최종 구역: ${finalZone.label} / 이동 ${session.steps}회`,
      `조우: 마물 ${monsterCount}회 / 보물 ${treasureCount}회`,
      "",
      `총 획득 골드: +${session.totalGold}G`,
      `수치 변화: ${fxLines}`,
      "",
      buildStatusLine(updated),
    ].join("\n");

    await postUnlisted(session.acct, text, session.threadId);
    await logAdventure(session.displayName, `솔로 / ${finalZone.label}`, forced ? "강제귀환" : "귀환", session.steps, monsterCount, session.totalGold, updated.gold);

  } else {
    // 레이드 종료 — 멤버 전원 처리
    const memberCount  = session.members.length;
    const goldPerMember = Math.floor(session.totalGold / memberCount);
    const updatedNames = [];

    for (const m of session.members) {
      memberToLeader.delete(m.accountId);

      const updated = await processPlayer(m.accountId, (p) => {
        const { stats, hidden } = applyEffects(p, session.totalEffects, 0);
        const gold              = Math.max(0, p.gold + goldPerMember);
        const history           = [...p.history];
        if (history.length > 0) {
          history[history.length - 1] = {
            ...history.at(-1),
            adventureResult: { steps: session.steps, totalGold: goldPerMember, effects: session.totalEffects, forced, raid: true, log: session.log },
          };
        }
        return { ...p, stats, hidden, gold, history };
      });

      updatedNames.push(`${m.displayName}: ${updated.gold}G`);
      await logAdventure(m.displayName, `레이드 / ${finalZone.label}`, forced ? "강제귀환" : "귀환", session.steps, monsterCount, goldPerMember, updated.gold);
    }

    const memberNames = session.members.map((m) => m.displayName).join(", ");

    const text = [
      `[레이드 귀환${forced ? " (강제)" : ""}] ${session.members.find(m => m.accountId === session.leaderId)?.displayName} 파티`,
      `참가자: ${memberNames}`,
      `최종 구역: ${finalZone.label} / 이동 ${session.steps}회`,
      `조우: 마물 ${monsterCount}회 / 보물 ${treasureCount}회`,
      "",
      `총 획득 골드: +${session.totalGold}G (1인당 +${goldPerMember}G)`,
      `수치 변화: ${fxLines}`,
      "",
      `[잔액] ${updatedNames.join(" / ")}`,
    ].join("\n");

    await postPublic(text, session.threadId);
  }
}

// ── 몬스터 목록 ───────────────────────────────────────────────
async function handleMonsterList(notification, location) {
  const monsters = await getMonsters();
  const entries  = Object.entries(monsters).filter(([, m]) =>
    location ? m.location === location : true
  );

  if (entries.length === 0) {
    await replyDM(notification, location ? `'${location}'에 등록된 마물이 없습니다.` : "등록된 마물이 없습니다.");
    return;
  }

  const lines = entries.map(([name, m]) =>
    `${name} [${m.location ?? "-"}] HP:${m.hp} 공:${m.atk} 방:${m.def} / ${m.goldMin ?? 0}~${m.goldMax ?? 0}G / ${m.desc ?? ""}`
  );

  await replyDM(notification, `[마물 목록${location ? ` — ${location}` : ""}]\n${lines.join("\n")}`);
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
        await handleSoloStart(notification, accountId, displayName, acct, token.value);
        break;
      case "레이드":
        await handleRaidOpen(notification, accountId, displayName, acct, token.value);
        break;
      case "참가":
        await handleRaidJoin(notification, accountId, displayName, acct);
        break;
      case "출발":
        await handleRaidDepart(notification, accountId);
        break;
      case "귀환":
        await handleReturn(notification, accountId);
        break;
      case "몬스터목록":
        await handleMonsterList(notification, token.value);
        break;
      default:
        await replyDM(notification,
          "알 수 없는 명령입니다.\n" +
          "[무사수행] 솔로 시작\n" +
          "[레이드] 또는 [레이드/마물명] 레이드 모집\n" +
          "[참가] 레이드 참가\n" +
          "[출발] 레이드 시작 (파티장)\n" +
          "[북][남][동][서] 이동\n" +
          "[귀환] 탐색 종료"
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
