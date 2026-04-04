// ============================================================
// adventure.js — 무사수행 봇
// ============================================================
import "dotenv/config";
import { createRestAPIClient, createStreamingAPIClient } from "masto";
import {
  calcSuccessRate,
  rollAdventure,
  ADVENTURE_OUTCOMES,
  calcAdventureGold,
  applyEffects,
  buildAdventureResult,
  getAge,
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
  const age      = getAge(player.turn);

  // 몬스터 결정
  let monster = null;
  if (monsterName) {
    monster = monsters[monsterName] ?? null;
    if (!monster) {
      await replyDM(notification, `'${monsterName}'은(는) 등록되지 않은 마물입니다.`);
      return;
    }
    if (age < (monster.minAge ?? 0)) {
      await replyDM(notification, `'${monsterName}'은(는) ${monster.minAge}세 이상만 도전할 수 있습니다.`);
      return;
    }
  } else {
    // 나이에 맞는 몬스터 중 랜덤 선택
    const pool = Object.values(monsters).filter((m) => (m.minAge ?? 0) <= age);
    if (pool.length > 0) {
      monster = pool[Math.floor(Math.random() * pool.length)];
    }
  }

  // 판정
  const successRate          = calcSuccessRate(player, monster);
  const { roll, result }     = rollAdventure(successRate);
  const goldDelta            = calcAdventureGold(result, monster);
  const outcome              = ADVENTURE_OUTCOMES[result];
  const { stats, hidden, gold } = applyEffects(player, outcome.effects, goldDelta);

  // 플레이어 저장 + history에 무사수행 결과 기록
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

  // 공개 게시
  const publicText = buildAdventureResult(
    player, updated, monster, result, roll, successRate, goldDelta
  );
  await postPublic(publicText);
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

  const lines = entries.map(([name, m]) => {
    const goldRange = `${m.goldMin ?? 0}~${m.goldMax ?? 0}G`;
    const loc       = m.location ?? "-";
    const desc      = m.desc     ?? "";
    return `${name} [${loc}] — HP:${m.hp} 공격:${m.atk} 방어:${m.def} / 골드:${goldRange} / ${desc}`;
  });

  await replyDM(notification,
    `[마물 목록${location ? ` — ${location}` : ""}]\n${lines.join("\n")}`
  );
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
        await replyDM(notification,
          "알 수 없는 명령입니다.\n[무사수행] 또는 [몬스터목록]을 입력해주세요."
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
