// ============================================================
// game.js — 수치 정의 / 행동 적용 / 전투 판정 / 상태 출력
// ============================================================
import { loadActions } from "./sheets.js";

// ── 공개 수치 ─────────────────────────────────────────────────
export const PUBLIC_STATS  = ["지능", "매력", "체력", "감성", "사회성"];
export const HIDDEN_STATS  = ["도덕성", "야망", "위험도", "의존성", "스트레스", "평판", "전투"];

export const INITIAL_STATS = {
  지능: 20, 매력: 20, 체력: 20, 감성: 20, 사회성: 20,
};
export const INITIAL_HIDDEN = {
  도덕성: 50, 야망: 10, 위험도: 0, 의존성: 0,
  스트레스: 10, 평판: 20, 전투: 0,
};

// ── 행동 캐시 ─────────────────────────────────────────────────

let _actionsCache    = null;
let _actionsCachedAt = 0;
const CACHE_TTL_MS   = 5 * 60 * 1000;

export async function getActions() {
  const now = Date.now();
  if (_actionsCache && now - _actionsCachedAt < CACHE_TTL_MS) return _actionsCache;
  _actionsCache    = await loadActions();
  _actionsCachedAt = now;
  return _actionsCache;
}

// ── 나잇대 / 단계 ─────────────────────────────────────────────

export function getAge(turn) {
  if (turn <= 8)  return 8  + Math.floor((turn - 1) / 2);
  if (turn <= 16) return 12 + Math.floor((turn - 9) / 2);
  return 16 + Math.floor((turn - 17) / 2);
}

export function getPhase(turn) {
  if (turn <= 8)  return "초기 성장기";
  if (turn <= 16) return "확장 단계";
  return "완성 단계";
}

// ── 유틸 ─────────────────────────────────────────────────────

export function clamp(v, min = 0, max = 100) {
  return Math.min(max, Math.max(min, v));
}

// ── 스케줄 유효성 검사 ────────────────────────────────────────

export async function validateSchedule(actions, age) {
  const ACTIONS = await getActions();
  const errors  = [];

  if (actions.length !== 3) {
    errors.push("행동은 정확히 3개여야 합니다");
    return errors;
  }

  const adventureCount = actions.filter((a) => a === "무사수행").length;
  if (adventureCount > 1) {
    errors.push("무사수행은 턴당 1회만 선택할 수 있습니다");
  }

  for (const name of actions) {
    const action = ACTIONS[name];
    if (!action) {
      errors.push(`'${name}'은(는) 없는 행동입니다`);
      continue;
    }
    if (age < action.minAge) {
      errors.push(`'${name}'은(는) ${action.minAge}세 이상만 선택할 수 있습니다`);
    }
  }

  return errors;
}

// ── 스케줄 행동 적용 ──────────────────────────────────────────

export async function applyActions(player, actions) {
  const ACTIONS = await getActions();
  const stats   = { ...player.stats };
  const hidden  = { ...player.hidden };
  let   gold    = player.gold;
  const log     = [];

  const counts = {};
  for (const name of actions) counts[name] = (counts[name] ?? 0) + 1;

  for (const name of actions) {
    if (name === "무사수행") {
      log.push({ action: name, changes: [], goldDelta: 0, note: "무사수행 봇에서 진행" });
      continue;
    }

    const action = ACTIONS[name];
    if (!action) continue;

    const penalty   = counts[name] > 1 ? 0.5 : 1;
    const changes   = [];
    const goldDelta = Math.round(action.gold * penalty);

    gold += goldDelta;

    for (const [stat, delta] of Object.entries(action.effects)) {
      const adjusted = Math.round(delta * penalty);
      if (adjusted === 0) continue;

      if (PUBLIC_STATS.includes(stat)) {
        stats[stat] = clamp(stats[stat] + adjusted, 0, 100);
        changes.push(`${stat}${adjusted > 0 ? "+" : ""}${adjusted}`);
      } else if (HIDDEN_STATS.includes(stat)) {
        hidden[stat] = clamp(hidden[stat] + adjusted, 0, 100);
      }
    }

    log.push({
      action:    name,
      changes,
      goldDelta,
      note:      counts[name] > 1 ? "반복 페널티 적용" : "",
    });
  }

  return {
    ...player,
    stats,
    hidden,
    gold,
    turn:    player.turn + 1,
    history: [
      ...player.history,
      { turn: player.turn, actions, log },
    ],
  };
}

// ── 무사수행 성공률 계산 ──────────────────────────────────────
// 기본값: 체력 * 0.2 + 전투 * 0.5 + 30
// 몬스터 방어력 있으면 def * 0.3 차감
// 하한 10 / 상한 85

export function calcSuccessRate(player, monster) {
  const base    = 30 + Math.floor(player.stats.체력 * 0.2 + player.hidden.전투 * 0.5);
  const penalty = monster ? Math.floor((monster.def ?? 0) * 0.3) : 0;
  return clamp(base - penalty, 10, 85);
}

// ── d100 판정 ─────────────────────────────────────────────────
// 대성공: roll <= successRate * 0.15
// 성공:   roll <= successRate
// 실패:   roll <= 95
// 대실패: roll > 95

export function rollAdventure(successRate) {
  const roll     = Math.floor(Math.random() * 100) + 1;
  const critZone = Math.floor(successRate * 0.15);

  let result;
  if      (roll <= critZone)    result = "대성공";
  else if (roll <= successRate) result = "성공";
  else if (roll <= 95)          result = "실패";
  else                          result = "대실패";

  return { roll, result };
}

// ── 무사수행 결과 정의 ────────────────────────────────────────

export const ADVENTURE_OUTCOMES = {
  대성공: {
    effects:     { 전투: 4, 스트레스: -3, 평판: 3, 야망: 1 },
    goldMulti:   1.5,   // 몬스터 평균 골드 * 1.5
    goldFallback: 250,  // 몬스터 없을 때 기본 보상
    narrative: (monsterName) => [
      `${monsterName ?? "적"}과 맞닥뜨렸다.`,
      "눈 깜짝할 사이에 승부가 갈렸다. 완벽한 승리였다.",
    ],
  },
  성공: {
    effects:     { 전투: 2, 스트레스: 2, 평판: 1 },
    goldMulti:   1.0,
    goldFallback: 100,
    narrative: (monsterName) => [
      `${monsterName ?? "적"}과 교전했다.`,
      "쉽지 않은 싸움이었지만 결국 물리쳤다.",
    ],
  },
  실패: {
    effects:     { 체력: -4, 스트레스: 4, 위험도: 2 },
    goldMulti:   0,
    goldFallback: 0,
    narrative: (monsterName) => [
      `${monsterName ?? "적"}에게 밀렸다.`,
      "간신히 목숨만 건져 돌아왔다.",
    ],
  },
  대실패: {
    effects:     { 체력: -7, 스트레스: 7, 위험도: 4 },
    goldMulti:   0,
    goldFallback: -50,
    narrative: (monsterName) => [
      `${monsterName ?? "적"}에게 크게 당했다.`,
      "의식을 잃었다가 겨우 정신을 차렸다. 소지품 일부를 잃었다.",
    ],
  },
};

// 결과에 따른 골드 계산
export function calcAdventureGold(result, monster) {
  const outcome = ADVENTURE_OUTCOMES[result];
  if (!monster) return outcome.goldFallback;

  if (outcome.goldMulti === 0) return 0;

  const avg = Math.floor((monster.goldMin + monster.goldMax) / 2);
  return Math.floor(avg * outcome.goldMulti);
}

// ── 수치 일괄 적용 ────────────────────────────────────────────

export function applyEffects(player, effects, goldDelta) {
  const stats  = { ...player.stats };
  const hidden = { ...player.hidden };
  const gold   = player.gold + goldDelta;

  for (const [stat, delta] of Object.entries(effects)) {
    if (PUBLIC_STATS.includes(stat))      stats[stat]  = clamp(stats[stat]  + delta, 0, 100);
    else if (HIDDEN_STATS.includes(stat)) hidden[stat] = clamp(hidden[stat] + delta, 0, 100);
  }

  return { stats, hidden, gold };
}

// ── 장착 아이템 효과 적용 ─────────────────────────────────────

export function applyEquipment(baseStats, equipped, items) {
  const stats = { ...baseStats };
  for (const itemName of Object.values(equipped)) {
    const item = items[itemName];
    if (!item?.equip) continue;
    for (const [stat, delta] of Object.entries(item.equip)) {
      if (stat in stats) stats[stat] = clamp(stats[stat] + delta, 0, 100);
    }
  }
  return stats;
}

// ── 단어 조합 판정 ────────────────────────────────────────────

const DESCRIPTORS = {
  지능: [
    { max: 15,       word: "무지한" },
    { max: 30,       word: "평범한" },
    { max: 50,       word: "총명한" },
    { max: 70,       word: "박식한" },
    { max: 85,       word: "현명한" },
    { max: Infinity, word: "천재적인" },
  ],
  매력: [
    { max: 15,       word: "눈에 띄지 않는" },
    { max: 30,       word: "평범한" },
    { max: 50,       word: "친근한" },
    { max: 70,       word: "매혹적인" },
    { max: 85,       word: "우아한" },
    { max: Infinity, word: "전설적인" },
  ],
  체력: [
    { max: 15,       word: "허약한" },
    { max: 30,       word: "보통의" },
    { max: 50,       word: "건강한" },
    { max: 70,       word: "강인한" },
    { max: Infinity, word: "불굴의" },
  ],
  감성: [
    { max: 15,       word: "무감각한" },
    { max: 30,       word: "평온한" },
    { max: 50,       word: "섬세한" },
    { max: 70,       word: "풍부한" },
    { max: Infinity, word: "예술적인" },
  ],
  사회성: [
    { max: 15,       word: "고독한" },
    { max: 30,       word: "조용한" },
    { max: 50,       word: "사교적인" },
    { max: 70,       word: "인기있는" },
    { max: Infinity, word: "카리스마 넘치는" },
  ],
};

const STRESS_DESC = [
  { max: 20,       word: "여유로운" },
  { max: 40,       word: "보통의" },
  { max: 60,       word: "피로한" },
  { max: 80,       word: "지친" },
  { max: Infinity, word: "한계에 달한" },
];

export function getDescriptor(stat, value) {
  const table = DESCRIPTORS[stat];
  if (!table) return "";
  return table.find((d) => value <= d.max)?.word ?? table.at(-1).word;
}

export function buildStatusLine(player) {
  const { 지능, 매력, 체력, 감성, 사회성 } = player.stats;
  return [
    `[${player.name}] ${getPhase(player.turn)} / ${getAge(player.turn)}세 / ${player.turn}턴`,
    `${getDescriptor("지능",   지능)}   지성`,
    `${getDescriptor("매력",   매력)}   외모`,
    `${getDescriptor("체력",   체력)}   체력`,
    `${getDescriptor("감성",   감성)}   감각`,
    `${getDescriptor("사회성", 사회성)} 대인관계`,
    `컨디션: ${STRESS_DESC.find((d) => player.hidden.스트레스 <= d.max)?.word}`,
    `소지금: ${player.gold}G`,
  ].join("\n");
}

// ── 무사수행 결과 전문 텍스트 생성 ───────────────────────────
// adventure.js에서 공개 게시용으로 호출

export function buildAdventureResult(player, updated, monster, result, roll, successRate, goldDelta) {
  const outcome      = ADVENTURE_OUTCOMES[result];
  const monsterName  = monster?.마물명 ?? null;
  const effectLines  = [
    ...Object.entries(outcome.effects).map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`),
    goldDelta !== 0 ? `골드${goldDelta > 0 ? "+" : ""}${goldDelta}G` : null,
  ].filter(Boolean).join(", ");

  return [
    `[${player.name}] 무사수행 — ${result}`,
    `주사위: ${roll} / 성공률: ${successRate}%`,
    monster ? `상대: ${monsterName} (${monster.location ?? "-"})` : "",
    "",
    ...outcome.narrative(monsterName),
    "",
    `변화: ${effectLines}`,
    "",
    buildStatusLine(updated),
  ].filter((l) => l !== "").join("\n");
}
