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
  let playerChannel = null;
  const playerChannels = new Map();
  let currentUser = null;
  let lastPresenceTrack = 0;
  let lastMovementWrite = 0;
  let positionPersistInFlight = false;
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

  function playerTopic(userId) {
    return "rip-world:" + currentRoom + ":player:" + userId;
  }

  async function subscribePlayerTopic(userId, handlers, own = false) {
    if (playerChannels.has(userId)) return playerChannels.get(userId);
    const playerChannel = supabase.channel(playerTopic(userId), {
      config: { private: true, broadcast: { self: false } }
    });
    playerChannels.set(userId, playerChannel);
    if (!own) {
      playerChannel.on("broadcast", { event: "player_position" }, ({ payload }) => {
        if (payload?.user_id !== userId || payload?.room_id !== currentRoom) return;
        handlers.onPlayerUpdate?.({
          userId: payload.user_id,
          x: payload.x,
          y: payload.y,
          facing: payload.facing,
          displayName: payload.display_name,
          skin: payload.character_id,
          level: payload.level,
          experience: payload.experience,
          last_seen_at: payload.sent_at
        });
      });
    }
    await new Promise((resolve, reject) => {
      playerChannel.subscribe(state => {
        if (state === "SUBSCRIBED") resolve(state);
        if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          playerChannels.delete(userId);
          reject(new Error("اتصال کانال حرکت بازیکن برقرار نشد."));
        }
      });
    });
    return playerChannel;
  }

  function syncPlayerTopics(state, handlers) {
    const activeIds = new Set(Object.keys(state || {}).filter(id => id !== currentUser.id));
    for (const id of activeIds) {
      if (!playerChannels.has(id)) {
        subscribePlayerTopic(id, handlers).catch(error => console.warn("Player movement subscription failed:", error));
      }
    }
    for (const [id, playerChannel] of playerChannels) {
      if (id !== currentUser.id && !activeIds.has(id)) {
        playerChannels.delete(id);
        supabase.removeChannel(playerChannel).catch(error => console.warn("Player channel cleanup failed:", error));
      }
    }
  }

  async function joinRoom(roomId, handlers = {}) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    if (channel) await supabase.removeChannel(channel);
    for (const oldChannel of playerChannels.values()) await supabase.removeChannel(oldChannel);
    playerChannels.clear();
    playerChannel = null;
    const room = String(roomId).slice(0, 40);
    currentRoom = room;
    channel = supabase.channel("rip-world:" + room, {
      config: { private: true, presence: { key: currentUser.id }, broadcast: { self: false } }
    });
    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        syncPlayerTopics(state, handlers);
        handlers.onPlayers?.(state);
      })
      .on("broadcast", { event: "chat" }, ({ payload }) => {
        if (payload?.userId && payload.userId !== currentUser.id) handlers.onChat?.(payload);
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
    playerChannel = await subscribePlayerTopic(currentUser.id, handlers, true);
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

  let pendingMovementPayload = null;
  let movementBroadcastInFlight = false;

  async function publishMove(position) {
    if (!channel || !playerChannel || !currentUser) return;
    // Keep only the newest position while a network send is pending. This prevents
    // a slow phone/network from building a queue of obsolete coordinates.
    pendingMovementPayload = {
      user_id: currentUser.id,
      room_id: currentRoom,
      x: Number.isFinite(position.x) ? position.x : 0,
      y: Number.isFinite(position.y) ? position.y : 0,
      facing: ["up", "down", "left", "right"].includes(position.facing) ? position.facing : "down",
      display_name: String(position.displayName || "بازیکن").trim().slice(0, 20),
      character_id: String(position.skin || "hero").slice(0, 20),
      sent_at: new Date(Date.now() + serverClockOffsetMs).toISOString()
    };
    if (movementBroadcastInFlight) return;
    movementBroadcastInFlight = true;
    try {
      while (pendingMovementPayload && playerChannel && currentUser) {
        const payload = pendingMovementPayload;
        pendingMovementPayload = null;
        const now = performance.now();

        if (now - lastPresenceTrack >= 10000) {
          lastPresenceTrack = now;
          channel?.track({ user_id: currentUser.id })
            .then(presenceResult => {
              if (presenceResult !== "ok") console.warn("Presence update was not accepted:", presenceResult);
            })
            .catch(presenceError => console.warn("Presence update failed:", presenceError));
        }

        // Send one fresh position at a time; intermediate stale positions are coalesced.
        const result = await playerChannel.send({
          type: "broadcast",
          event: "player_position",
          payload
        });
        if (result !== "ok") throw new Error("ارسال حرکت بازیکن تأیید نشد.");

        // Persist an occasional snapshot without blocking realtime movement.
        if (!positionPersistInFlight && now - lastMovementWrite >= 1500) {
          lastMovementWrite = now;
          positionPersistInFlight = true;
          supabase.from("world_players")
            .update({
              x: payload.x,
              y: payload.y,
              facing: payload.facing,
              display_name: payload.display_name,
              character_id: payload.character_id,
              room_id: payload.room_id
            })
            .eq("user_id", currentUser.id)
            .eq("room_id", payload.room_id)
            .select("user_id")
            .maybeSingle()
            .then(({ data, error }) => {
              if (error) console.warn("Player snapshot save failed:", error);
              else if (!data?.user_id) console.warn("Player snapshot was not accepted by server.");
            })
            .catch(error => console.warn("Player snapshot save failed:", error))
            .finally(() => { positionPersistInFlight = false; });
        }
      }
    } finally {
      movementBroadcastInFlight = false;
      // A new position may have arrived just as the send loop was finishing.
      if (pendingMovementPayload && playerChannel && currentUser) {
        publishMove({ ...pendingMovementPayload, displayName: pendingMovementPayload.display_name, skin: pendingMovementPayload.character_id });
      }
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
    for (const playerChannel of playerChannels.values()) {
      await supabase.removeChannel(playerChannel);
    }
    playerChannels.clear();
    playerChannel = null;
  }

  return { connect, getClockStatus, getServerNowMs: () => Date.now() + serverClockOffsetMs, loadCharacter, loadRoomPlayers, saveCharacter, joinRoom, publishMove, sendChat, loadRecentChat, leave };
}
