import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js?v=5";

const validConfig =
  SUPABASE_URL.startsWith("https://") &&
  !SUPABASE_URL.includes("YOUR_PROJECT_ID") &&
  SUPABASE_ANON_KEY.length > 20 &&
  !SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");

export function createRipOnline() {
  if (!validConfig) throw new Error("تنظیمات سرور آنلاین هنوز وارد نشده است.");

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  let channel = null;
  let currentUser = null;
  let currentRoom = "mm-world-main";
  let serverClockOffsetMs = 0;
  let lastClockSyncMono = 0;

  async function syncServerClock() {
    const wallBefore = Date.now();
    const monoBefore = performance.now();
    const { data, error } = await supabase.rpc("mm_get_server_clock");
    const monoAfter = performance.now();
    const wallAfter = Date.now();
    if (error) throw error;
    const serverMs = Date.parse(data);
    if (!Number.isFinite(serverMs)) throw new Error("زمان سرور دریافت نشد.");
    serverClockOffsetMs = serverMs - ((wallBefore + wallAfter) / 2);
    lastClockSyncMono = monoAfter;
    return { offsetMs: serverClockOffsetMs, roundTripMs: monoAfter - monoBefore };
  }

  function getClockStatus() {
    return { offsetMs: serverClockOffsetMs, serverNowMs: Date.now() + serverClockOffsetMs };
  }

  async function connect() {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;
    let user = sessionData.session?.user;
    if (!user) {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      user = data.user;
    }
    currentUser = user;
    await syncServerClock();
    return { userId: user.id, ...getClockStatus() };
  }

  async function loadCharacter() {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const { data, error } = await supabase
      .from("world_players")
      .select("display_name,character_id,room_id,x,y,facing,level,experience,name_setup_completed")
      .eq("user_id", currentUser.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function loadEconomy() {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const { data, error } = await supabase.rpc("mm_get_economy");
    if (error) throw error;
    return data;
  }

  async function loadHomeEconomy() {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const user = data.session?.user;
    if (!user) return null;
    currentUser = user;
    const [economy, character] = await Promise.all([loadEconomy(), loadCharacter()]);
    return { economy, character };
  }

  async function buyCharacter(characterId) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const { data, error } = await supabase.rpc("mm_buy_character", { p_character_id: String(characterId) });
    if (error) throw error;
    return data;
  }

  async function equipCharacter(characterId) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const { data, error } = await supabase.rpc("mm_equip_character", { p_character_id: String(characterId) });
    if (error) throw error;
    return data;
  }

  async function saveCharacter(character) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const { data, error } = await supabase.rpc("mm_save_player", {
      p_display_name: String(character.displayName || "بازیکن").trim().slice(0, 20),
      p_character_id: String(character.characterId || "hero").slice(0, 40),
      p_room_id: String(character.roomId || "mm-world-main").slice(0, 40),
      p_x: Number.isFinite(character.x) ? character.x : 2500,
      p_y: Number.isFinite(character.y) ? character.y : 2500,
      p_facing: ["up", "down", "left", "right"].includes(character.facing) ? character.facing : "down"
    });
    if (error) throw error;
    return data;
  }

  async function confirmPlayerName(displayName) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const { data, error } = await supabase.rpc("mm_confirm_player_name", {
      p_display_name: String(displayName || "").trim().slice(0, 20)
    });
    if (error) throw error;
    return data;
  }

  async function updatePosition(position) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const { data, error } = await supabase.rpc("mm_update_player_position", {
      p_x: Number(position.x),
      p_y: Number(position.y),
      p_facing: ["up", "down", "left", "right"].includes(position.facing) ? position.facing : "down"
    });
    if (error) throw error;
    return data;
  }

  async function startQuest() {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const { data, error } = await supabase.rpc("mm_start_quest");
    if (error) throw error;
    return data;
  }

  async function collectHerb(spotId) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const { data, error } = await supabase.rpc("mm_collect_herb", { p_spot_id: Number(spotId) });
    if (error) throw error;
    return data;
  }

  async function completeQuest() {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const { data, error } = await supabase.rpc("mm_complete_quest");
    if (error) throw error;
    return data;
  }

  async function joinRoom(roomId, handlers = {}) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    if (channel) await supabase.removeChannel(channel);
    const room = String(roomId).slice(0, 40);
    currentRoom = room;
    channel = supabase.channel("rip-world:" + room, {
      config: { private: true, presence: { key: currentUser.id }, broadcast: { self: false } }
    });
    channel
      .on("presence", { event: "sync" }, () => {
        handlers.onPlayers?.(channel.presenceState());
      })
      .on("broadcast", { event: "player_position" }, ({ payload }) => {
        if (!payload?.user_id || payload.user_id === currentUser.id || payload.room_id !== room) return;
        handlers.onPlayerUpdate?.({
          userId: payload.user_id,
          x: payload.x,
          y: payload.y,
          facing: payload.facing,
          displayName: payload.display_name,
          skin: payload.character_id,
          level: payload.level,
          experience: payload.experience,
          last_seen_at: payload.last_seen_at
        });
      })
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "world_chat",
        filter: `room_id=eq.${room}`
      }, ({ new: row }) => {
        if (row?.user_id && row.user_id !== currentUser.id) {
          handlers.onChat?.({
            id: row.id,
            userId: row.user_id,
            displayName: row.display_name,
            message: row.message,
            createdAt: row.created_at
          });
        }
      });

    await new Promise((resolve, reject) => {
      channel.subscribe(state => {
        if (state === "SUBSCRIBED") resolve(state);
        if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          reject(new Error("اتصال به اتاق بازی برقرار نشد."));
        }
      });
    });
    return "SUBSCRIBED";
  }

  async function loadRoomPlayers(roomId) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    if (performance.now() - lastClockSyncMono > 30000) {
      try { await syncServerClock(); }
      catch (clockError) { console.warn("Server clock resync failed:", clockError); }
    }
    const { data, error } = await supabase.rpc("mm_get_active_world_players", {
      p_room: String(roomId).slice(0, 40)
    });
    if (error) throw error;
    return data || [];
  }

  let lastPublishedPosition = null;
  let lastPresenceTrack = 0;
  let lastMovementWrite = 0;
  let positionPersistInFlight = false;

  async function publishMove(position) {
    if (!channel || !currentUser) return { accepted: false };
    const now = performance.now();

    if (now - lastPresenceTrack >= 10000) {
      lastPresenceTrack = now;
      channel.track({ user_id: currentUser.id })
        .then(result => {
          if (result !== "ok") console.warn("Presence update was not accepted:", result);
        })
        .catch(error => console.warn("Presence update failed:", error));
    }

    if (positionPersistInFlight || now - lastMovementWrite < 650) return { accepted: true, skipped: true };
    const x = Number(position.x);
    const y = Number(position.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { accepted: false };
    if (lastPublishedPosition && Math.hypot(x-lastPublishedPosition.x,y-lastPublishedPosition.y)<0.8) {
      return { accepted: true, skipped: true };
    }

    lastMovementWrite = now;
    positionPersistInFlight = true;
    try {
      await updatePosition({ x, y, facing: position.facing });
      lastPublishedPosition = { x, y };
      return { accepted: true };
    } catch (error) {
      const detail = String(error?.message || "");
      if (/too frequent/i.test(detail)) return { accepted: true, skipped: true };
      console.warn("Server rejected player movement:", error);
      try {
        const authoritative = await loadCharacter();
        return { accepted: false, position: authoritative };
      } catch (readError) {
        console.warn("Could not reload authoritative player position:", readError);
        return { accepted: false };
      }
    } finally {
      positionPersistInFlight = false;
    }
  }

  async function sendChat(roomId, message, displayName) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const clean = String(message || "").trim().slice(0, 300);
    if (!clean) return;
    const safeName = String(displayName || "بازیکن").trim().slice(0, 20);
    const { data, error } = await supabase
      .from("world_chat")
      .insert({
        user_id: currentUser.id,
        room_id: String(roomId).slice(0, 40),
        display_name: safeName,
        message: clean
      })
      .select("id,user_id,display_name,message,created_at")
      .single();
    if (error) throw error;
    // Chat is delivered through the authenticated world_chat Postgres Changes feed.
    return data;
  }

  async function loadRecentChat(roomId, limit = 40) {
    const { data, error } = await supabase
      .from("world_chat")
      .select("id,user_id,display_name,message,created_at")
      .eq("room_id", String(roomId).slice(0, 40))
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 100));
    if (error) throw error;
    return (data || []).reverse();
  }

  async function leave() {
    if (channel) {
      await supabase.removeChannel(channel);
      channel = null;
    }
    lastPublishedPosition = null;
    positionPersistInFlight = false;
  }

  return { connect, getClockStatus, getServerNowMs: () => Date.now() + serverClockOffsetMs, loadCharacter, loadEconomy, loadHomeEconomy, buyCharacter, confirmPlayerName, equipCharacter, loadRoomPlayers, saveCharacter, updatePosition, startQuest, collectHerb, completeQuest, joinRoom, publishMove, sendChat, loadRecentChat, leave };
}
