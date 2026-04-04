// ============================================================
// storage.js — 플레이어 데이터 관리 (Google Sheets 기반)
// ============================================================
import { INITIAL_STATS, INITIAL_HIDDEN } from "./game.js";
import {
  loadPlayer,
  loadAllPlayers,
  savePlayer,
  loadItems,
} from "./sheets.js";

const MAX_TURNS = Number(process.env.MAX_TURNS ?? 24);

function clamp(v, min = 0, max = 100) {
  return Math.min(max, Math.max(min, v));
}

// ── 플레이어 기본 CRUD ────────────────────────────────────────

export async function getPlayer(accountId, displayName) {
  let player = await loadPlayer(accountId);

  if (!player) {
    player = {
      accountId,
      name:      displayName,
      stats:     { ...INITIAL_STATS },
      hidden:    { ...INITIAL_HIDDEN },
      gold:      500,
      inventory: [],
      equipped:  {},
      turn:      1,
      history:   [],
    };
    await savePlayer(player);
  }

  return player;
}

export async function updatePlayer(player) {
  await savePlayer(player);
}

export async function getAllPlayers() {
  const map = await loadAllPlayers();
  return Object.values(map);
}

// applyFn: player => updatedPlayer
export async function processPlayer(accountId, applyFn) {
  const player = await loadPlayer(accountId);
  if (!player) return null;
  const updated = applyFn(player);
  await savePlayer(updated);
  return updated;
}

// ── 스케줄 봇용 ──────────────────────────────────────────────

// 마지막 history의 turn이 현재 turn - 1이면 이미 제출한 것
export async function hasSubmittedThisTurn(accountId, displayName) {
  const player = await getPlayer(accountId, displayName);
  const last   = player.history.at(-1);
  return last?.turn === player.turn - 1;
}

export async function isEnded(accountId, displayName) {
  const player = await getPlayer(accountId, displayName);
  return player.turn > MAX_TURNS;
}

// ── 무사수행 봇용 ─────────────────────────────────────────────

// 이번 턴 스케줄에 무사수행이 포함되어 있고 아직 결과가 없는 경우만 허용
export async function canDoAdventure(accountId, displayName) {
  const player = await getPlayer(accountId, displayName);
  const last   = player.history.at(-1);
  if (!last)                              return false;
  if (last.turn !== player.turn - 1)     return false;
  if (!last.actions.includes("무사수행")) return false;
  if (last.adventureResult)              return false;
  return true;
}

// ── 상점 봇용 — 골드 ─────────────────────────────────────────

export async function adjustGold(accountId, displayName, delta) {
  return processPlayer(accountId, (p) => ({
    ...p,
    gold: p.gold + delta,
  }));
}

// ── 상점 봇용 — 인벤토리 ─────────────────────────────────────

export async function hasItem(accountId, displayName, itemName) {
  const player = await getPlayer(accountId, displayName);
  return player.inventory.includes(itemName);
}

export async function buyItem(accountId, displayName, itemName) {
  const items = await loadItems();
  const item  = items[itemName];
  if (!item) return { ok: false, reason: "존재하지 않는 아이템입니다." };

  const player = await getPlayer(accountId, displayName);
  if (player.gold < item.price) {
    return { ok: false, reason: `골드가 부족합니다. (보유: ${player.gold}G / 필요: ${item.price}G)` };
  }

  const updated = await processPlayer(accountId, (p) => ({
    ...p,
    gold:      p.gold - item.price,
    inventory: [...p.inventory, itemName],
  }));

  return { ok: true, updated };
}

export async function sellItem(accountId, displayName, itemName) {
  const items  = await loadItems();
  const item   = items[itemName];
  const player = await getPlayer(accountId, displayName);

  if (!item) return { ok: false, reason: "존재하지 않는 아이템입니다." };

  const idx = player.inventory.indexOf(itemName);
  if (idx === -1) return { ok: false, reason: "인벤토리에 없는 아이템입니다." };

  if (Object.values(player.equipped).includes(itemName)) {
    return { ok: false, reason: `장착 중인 아이템입니다. 먼저 [제거/${item.slot}]을 해주세요.` };
  }

  const updated = await processPlayer(accountId, (p) => {
    const inv = [...p.inventory];
    inv.splice(idx, 1);
    return { ...p, gold: p.gold + item.sellPrice, inventory: inv };
  });

  return { ok: true, updated };
}

// ── 상점 봇용 — 장착 ─────────────────────────────────────────

const 장착형카테고리 = new Set(["무기", "방패", "의상", "장신구"]);

export async function equipItem(accountId, displayName, itemName) {
  const items  = await loadItems();
  const item   = items[itemName];
  const player = await getPlayer(accountId, displayName);

  if (!item)                                return { ok: false, reason: "존재하지 않는 아이템입니다." };
  if (!장착형카테고리.has(item.category))   return { ok: false, reason: "장착할 수 없는 아이템입니다." };
  if (!player.inventory.includes(itemName)) return { ok: false, reason: "인벤토리에 없는 아이템입니다." };

  const prev    = player.equipped[item.slot] ?? null;
  const updated = await processPlayer(accountId, (p) => ({
    ...p,
    equipped: { ...p.equipped, [item.slot]: itemName },
  }));

  return { ok: true, updated, prev };
}

export async function unequipSlot(accountId, displayName, slot) {
  const player = await getPlayer(accountId, displayName);
  const item   = player.equipped[slot];

  if (!item) return { ok: false, reason: `'${slot}' 슬롯에 장착된 아이템이 없습니다.` };

  const updated = await processPlayer(accountId, (p) => {
    const equipped = { ...p.equipped };
    delete equipped[slot];
    return { ...p, equipped };
  });

  return { ok: true, updated, removed: item };
}

// ── 상점 봇용 — 소비 아이템 사용 ─────────────────────────────

export async function useItem(accountId, displayName, itemName, PUBLIC_STATS, HIDDEN_STATS) {
  const items  = await loadItems();
  const item   = items[itemName];
  const player = await getPlayer(accountId, displayName);

  if (!item)                    return { ok: false, reason: "존재하지 않는 아이템입니다." };
  if (item.category !== "소비") return { ok: false, reason: "사용할 수 없는 아이템입니다." };

  const idx = player.inventory.indexOf(itemName);
  if (idx === -1) return { ok: false, reason: "인벤토리에 없는 아이템입니다." };

  const updated = await processPlayer(accountId, (p) => {
    const stats  = { ...p.stats };
    const hidden = { ...p.hidden };
    const inv    = [...p.inventory];
    inv.splice(idx, 1);

    for (const [stat, delta] of Object.entries(item.use)) {
      if (PUBLIC_STATS.includes(stat))      stats[stat]  = clamp(stats[stat]  + delta, 0, 100);
      else if (HIDDEN_STATS.includes(stat)) hidden[stat] = clamp(hidden[stat] + delta, 0, 100);
    }

    return { ...p, stats, hidden, inventory: inv };
  });

  return { ok: true, updated };
}

// ── 상점 봇용 — 음식 즉시 적용 ───────────────────────────────

export async function eatFood(accountId, displayName, itemName, PUBLIC_STATS, HIDDEN_STATS) {
  const items  = await loadItems();
  const item   = items[itemName];
  const player = await getPlayer(accountId, displayName);

  if (!item)                    return { ok: false, reason: "존재하지 않는 아이템입니다." };
  if (item.category !== "음식") return { ok: false, reason: "음식이 아닙니다." };
  if (player.gold < item.price) {
    return { ok: false, reason: `골드가 부족합니다. (보유: ${player.gold}G / 필요: ${item.price}G)` };
  }

  const updated = await processPlayer(accountId, (p) => {
    const stats  = { ...p.stats };
    const hidden = { ...p.hidden };

    for (const [stat, delta] of Object.entries(item.use)) {
      if (PUBLIC_STATS.includes(stat))      stats[stat]  = clamp(stats[stat]  + delta, 0, 100);
      else if (HIDDEN_STATS.includes(stat)) hidden[stat] = clamp(hidden[stat] + delta, 0, 100);
    }

    return { ...p, stats, hidden, gold: p.gold - item.price };
  });

  return { ok: true, updated };
}
