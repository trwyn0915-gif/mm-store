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
  let lastPresenceTrack = 0;
  let lastMovementWrite = 0;
  let lastWrittenPosition = null;
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
      .select("display_name,character_id,room_id,x,y,facing,level,experience")
      .eq("user_id", currentUser.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function saveCharacter(character) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const now = new Date().toISOString();
    const row = {
      user_id: currentUser.id,
      display_name: String(character.displayName || "بازیکن").trim().slice(0, 20),
      character_id: String(character.characterId || "survivor").slice(0, 40),
      room_id: String(character.roomId || "station").slice(0, 40),
      x: Number.isFinite(character.x) ? character.x : 480,
      y: Number.isFinite(character.y) ? character.y : 270,
      facing: ["up", "down", "left", "right"].includes(character.facing) ? character.facing : "down",
      last_seen_at: now,
      updated_at: now
    };
    const { data: updated, error: updateError } = await supabase
      .from("world_players")
      .update({
        display_name: row.display_name,
        character_id: row.character_id,
        room_id: row.room_id,
        facing: row.facing
      })
      .eq("user_id", currentUser.id)
      .eq("room_id", row.room_id)
      .select("user_id")
      .maybeSingle();
    if (updateError) throw updateError;
    if (updated?.user_id) return row;

    const { error: insertError } = await supabase.from("world_players").insert(row);
    if (insertError) throw insertError;
    return row;
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
      .on("presence", { event: "sync" }, () => handlers.onPlayers?.(channel.presenceState()))
      .on("broadcast", { event: "chat" }, ({ payload }) => {
        if (payload?.userId && payload.userId !== currentUser.id) handlers.onChat?.(payload);
      })
      // Positions are broadcast by a database trigger after the authenticated row update.
      .on("broadcast", { event: "player_position" }, ({ payload }) => {
        if (payload?.user_id && payload.user_id !== currentUser.id) {
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
        }
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

  async function publishMove(position) {
    if (!channel || !currentUser) return;
    const payload = {
      userId: currentUser.id,
      x: Number.isFinite(position.x) ? position.x : 0,
      y: Number.isFinite(position.y) ? position.y : 0,
      facing: ["up", "down", "left", "right"].includes(position.facing) ? position.facing : "down",
      displayName: String(position.displayName || "بازیکن").trim().slice(0, 20),
      skin: String(position.skin || "hero").slice(0, 20)
    };
    const now = performance.now();
    const lastSeenAt = new Date(Date.now()).toISOString();

    // Keep position writes frequent enough for responsive movement; peers receive
    // compact Broadcast events from the database trigger, not Postgres Changes.

    // Presence is only a connection hint. It is not trusted for identity or position.
    if (now - lastPresenceTrack >= 10000) {
      lastPresenceTrack = now;
      try {
        const presenceResult = await channel.track(payload);
        if (presenceResult !== "ok") console.warn("Presence update was not accepted:", presenceResult);
      } catch (presenceError) {
        console.warn("Presence update failed:", presenceError);
      }
    }

    const moved = !lastWrittenPosition ||
      Math.hypot(payload.x - lastWrittenPosition.x, payload.y - lastWrittenPosition.y) >= 0.25;
    const heartbeat = now - lastMovementWrite >= 2000;
    if (lastMovementWrite && now - lastMovementWrite < 100) return;
    if (!moved && !heartbeat) return;

    // RLS binds this update to auth.uid(); peers receive the committed database row.
    const { data, error } = await supabase
      .from("world_players")
      .update({
        x: payload.x,
        y: payload.y,
        facing: payload.facing,
        display_name: payload.displayName,
        character_id: payload.skin,
        room_id: currentRoom,
        last_seen_at: lastSeenAt
      })
      .eq("user_id", currentUser.id)
      .eq("room_id", currentRoom)
      .select("user_id")
      .maybeSingle();
    if (error) throw error;
    if (!data?.user_id) throw new Error("موقعیت بازیکن توسط سرور تأیید نشد.");
    lastMovementWrite = now;
    lastWrittenPosition = { x: payload.x, y: payload.y };
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
  }

  return { connect, getClockStatus, getServerNowMs: () => Date.now() + serverClockOffsetMs, loadCharacter, loadRoomPlayers, saveCharacter, joinRoom, publishMove, sendChat, loadRecentChat, leave };
}
