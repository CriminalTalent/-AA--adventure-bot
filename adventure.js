// ============================================================
// adventure.js — 무사수행 봇
// ============================================================
import "dotenv/config";
import { createRestAPIClient, createStreamingAPIClient } from "masto";
import { PUBLIC_STATS, HIDDEN_STATS, buildStatusLine }   from "./game.js";
import { getPlayer, canDoAdventure, processPlayer }      from "./storage.js";
import { loadMonsters, logAdventure }                    from "./sheets.js";

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

// ── 결과 단계 정의 ────────────────────────────────────────────
// 성공률 기준:
//   대성공: roll <= successRate * 0.15
//   성공:   roll <= successRate
//   실패:   roll <= 95
//   대실패: roll > 95

const OUTCOMES = {
  대성공: {
    narrative: (monster) => [
      `${monster ? monster.dialogue ?? monster.마물명 : "적"}과 맞닥뜨렸다.`,
      "눈 깜짝할 사이에 승부가 갈렸다. 완벽한 승리였다.",
    ],
    effects: { 전투: 4, 스트레스: -3, 평판: 3, 야망: 1 },
    goldBase: (monster) => monster
      ? Math.floor((monster.goldMin + monster.goldMax) / 2 * 1.5)
      : 250,
  },
  성공: {
    narrative: (monster) => [
      `${monster ? monster.dialogue ?? monster.마물명 : "적"}과 교전했다.`,
      "쉽지 않은 싸움이었지만 결국 물리쳤다.",
    ],
    effects: { 전투: 2, 스트레스: 2, 평판: 1 },
    goldBase: (monster) => monster
      ? Math.floor(monster.goldMin + (monster.goldMax - monster.goldMin) * Math.random())
      : 100,
  },
  실패: {
    narrative: (monster) => [
      `${monster ? monster.dialogue ?? monster.마물명 : "적"}에게 밀렸다.`,
      "간신히 목숨만 건져 돌아왔다.",
    ],
    effects: { 체력: -4, 스트레스: 4, 위험도: 2 },
    goldBase: () => 0,
  },
  대실패: {
    narrative: (monster) => [
      `${monster ? monster.dialogue ?? monster.마물명 : "적"}에게 크게 당했다.`,
      "의식을 잃었다가 겨우 정신을 차렸다. 소지품 일부를 잃었다.",
    ],
    effects: { 체력: -7, 스트레스: 7, 위험도: 4 },
    goldBase: () => -50,
  },
};

// ── 성공률 계산 ───────────────────────────────────────────────
// 기본값: 체력 * 0.2 + 전투 * 0.5 + 30
// 몬스터 방어력이 있으면 차감
// 하한 10 / 상한 85

function calcSuccessRate(player, monster) {
  const base    = 30 + Math.floor(player.stats.체력 * 0.2 + player.hidden.전투 * 0.5);
  const penalty = monster ? Math.floor(monster.def * 0.3) : 0;
  return Math.min(85, Math.max(10, base - penalty));
}

// ── d100 판정 ─────────────────────────────────────────────────

function rollOutcome(successRate) {
  const roll      = Math.floor(Math.random() * 100) + 1;
  const critZone  = Math.floor(successRate * 0.15);

  let result;
  if      (roll <= critZone)    result = "대성공";
  else if (roll <= successRate) result = "성공";
  else if (roll <= 95)          result = "실패";
  else                          result = "대실패";

  return { roll, result };
}

// ── 수치 적용 ─────────────────────────────────────────────────

function clamp(v, min = 0, max = 100) {
  return Math.min(max, Math.max(min, v));
}

function applyEffects(player, effects, goldDelta) {
  const stats  = { ...player.stats };
  const hidden = { ...player.hidden };
  let   gold   = player.gold + goldDelta;

  for (const [stat, delta] of Object.entries(effects)) {
    if (PUBLIC_STATS.includes(stat))      stats[stat]  = clamp(stats[stat]  + delta, 0, 100);
    else if (HIDDEN_STATS.includes(stat)) hidden[stat] = clamp(hidden[stat] + delta, 0, 100);
  }

  return { stats, hidden, gold };
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

// ── 명령 핸들러 ───────────────────────────────────────────────

// [무사수행] or [무사수행/몬스터명]
async function handleAdventure(notification, accountId, displayName, monsterName) {
  const ok = await canDoAdventure(accountId, displayName);
  if (!ok) {
    await replyDM(notification,
      "현재 무사수행을 진행할 수 없습니다.\n" +
      "스케줄 봇에 [스케줄/무사수행/...]을 포함하여 제출했는지 확인해주세요."
    );
    return;
  }

  const player   = await getPlayer(accountId, displayName);
  const monsters = await getMonsters();
  const age      = player.turn <= 8  ? 8 + Math.floor((player.turn - 1) / 2)
                 : player.turn <= 16 ? 12 + Math.floor((player.turn - 9) / 2)
                 : 16 + Math.floor((player.turn - 17) / 2);

  // 몬스터 결정
  let monster = null;
  if (monsterName) {
    monster = monsters[monsterName] ?? null;
    if (!monster) {
      await replyDM(notification, `'${monsterName}'은(는) 등록되지 않은 마물입니다.`);
      return;
    }
    if (age < monster.minAge) {
      await replyDM(notification, `'${monsterName}'은(는) ${monster.minAge}세 이상만 도전할 수 있습니다.`);
      return;
    }
  } else {
    // 나이에 맞는 몬스터 중 랜덤 선택
    const pool = Object.values(monsters).filter((m) => m.minAge <= age);
    if (pool.length > 0) {
      monster = pool[Math.floor(Math.random() * pool.length)];
    }
  }

  // 판정
  const successRate        = calcSuccessRate(player, monster);
  const { roll, result }   = rollOutcome(successRate);
  const outcome            = OUTCOMES[result];
  const goldDelta          = outcome.goldBase(monster);
  const { stats, hidden, gold } = applyEffects(player, outcome.effects, goldDelta);

  // 플레이어 저장 + 무사수행 결과 history에 기록
  const updated = await processPlayer(accountId, (p) => {
    const history = [...p.history];
    if (history.length > 0) {
      history[history.length - 1] = {
        ...history.at(-1),
        adventureResult: {
          result,
          roll,
          successRate,
          monster: monster?.마물명 ?? null,
          goldDelta,
        },
      };
    }
    return { ...p, stats, hidden, gold, history };
  });

  // 효과 텍스트
  const effectLines = [
    ...Object.entries(outcome.effects).map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`),
    goldDelta !== 0 ? `골드${goldDelta > 0 ? "+" : ""}${goldDelta}G` : null,
  ].filter(Boolean).join(", ");

  // 공개 게시
  const publicLines = [
    `[${player.name}] 무사수행 — ${result}`,
    `주사위: ${roll} / 성공률: ${successRate}%`,
    monster ? `상대: ${monster.마물명} (${monster.location ?? ""})` : "",
    "",
    ...outcome.narrative(monster),
    "",
    `변화: ${effectLines}`,
    "",
    buildStatusLine(updated),
  ].filter((l) => l !== undefined);

  await postPublic(publicLines.join("\n"));
  await replyDM(notification, `무사수행 완료 (${result}). 결과가 공개 게시되었습니다.`);

  // 시트 기록
  await logAdventure(
    displayName,
    monster?.마물명 ?? "랜덤",
    result,
    roll,
    successRate,
    goldDelta,
    updated.gold
  );
}

// [몬스터목록] or [몬스터목록/장소]
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

  const lines = entries.map(([name, m]) =>
    `${name} [${m.location ?? "-"}] — HP:${m.hp} 공격:${m.atk} 방어:${m.def} / 골드:${m.goldMin}~${m.goldMax}G / ${m.desc ?? ""}`
  );

  await replyDM(notification, `[마물 목록${location ? ` — ${location}` : ""}]\n${lines.join("\n")}`);
}

// ── 명령 분기 ─────────────────────────────────────────────────

async function handleNotification(notification) {
  if (notification.type !== "mention")               return;
  if (!notification.status || !notification.account) return;

  const accountId   = notification.account.id;
  const acct        = notification.account.acct;
  const displayName = notification.account.displayName || acct;
  const tokens      = parseTokens(notification.status.content);

  if (tokens.length === 0) return;

  for (const token of tokens) {
    switch (token.key) {
      case "무사수행":
        await handleAdventure(notification, accountId, displayName, token.value);
        break;
      case "몬스터목록":
        await handleMonsterList(notification, token.value);
        break;
      default:
        await replyDM(notification, "알 수 없는 명령입니다. [무사수행] 또는 [몬스터목록]을 입력해주세요.");
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
