import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const validConfig =
  SUPABASE_URL.startsWith("https://") &&
  !SUPABASE_URL.includes("YOUR_PROJECT_ID") &&
  SUPABASE_ANON_KEY.length > 20 &&
  !SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");

export function createRipOnline() {
  if (!validConfig) {
    throw new Error("تنظیمات سرور آنلاین هنوز وارد نشده است.");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  let channel = null;
  let currentUser = null;

  async function connect() {
    const { data: sessionData, error: sessionError } =
      await supabase.auth.getSession();
    if (sessionError) throw sessionError;

    let user = sessionData.session?.user;
    if (!user) {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      user = data.user;
    }
    currentUser = user;
    return { userId: user.id };
  }

  async function saveCharacter(character) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const row = {
      user_id: currentUser.id,
      display_name: String(character.displayName || "بازیکن").trim().slice(0, 20),
      character_id: String(character.characterId || "survivor").slice(0, 40),
      room_id: String(character.roomId || "station").slice(0, 40),
      x: Number.isFinite(character.x) ? character.x : 480,
      y: Number.isFinite(character.y) ? character.y : 270,
      facing: ["up", "down", "left", "right"].includes(character.facing)
        ? character.facing : "down",
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const { error } = await supabase.from("world_players").upsert(row);
    if (error) throw error;
    return row;
  }

  async function joinRoom(roomId, handlers = {}) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    if (channel) await supabase.removeChannel(channel);

    channel = supabase.channel("rip-world:" + String(roomId).slice(0, 40), {
      config: { presence: { key: currentUser.id }, broadcast: { self: false } }
    });

    channel
      .on("presence", { event: "sync" }, () => {
        handlers.onPlayers?.(channel.presenceState());
      })
      .on("broadcast", { event: "move" }, ({ payload }) => {
        if (payload?.userId !== currentUser.id) handlers.onMove?.(payload);
      })
      .on("broadcast", { event: "chat" }, ({ payload }) => {
        handlers.onChat?.(payload);
      });

    const status = await new Promise((resolve, reject) => {
      channel.subscribe(async state => {
        if (state === "SUBSCRIBED") resolve(state);
        if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          reject(new Error("اتصال به اتاق بازی برقرار نشد."));
        }
      });
    });
    return status;
  }

  async function publishMove(position) {
    if (!channel || !currentUser) return;
    await channel.track({
      userId: currentUser.id,
      x: Number(position.x) || 0,
      y: Number(position.y) || 0,
      facing: position.facing || "down",
      displayName: String(position.displayName || "بازیکن").slice(0, 20),
      sentAt: Date.now()
    });
    await channel.send({
      type: "broadcast",
      event: "move",
      payload: {
        userId: currentUser.id,
        x: Number(position.x) || 0,
        y: Number(position.y) || 0,
        facing: position.facing || "down",
        displayName: String(position.displayName || "بازیکن").slice(0, 20)
      }
    });
  }

  async function sendChat(roomId, message, displayName) {
    if (!currentUser) throw new Error("ابتدا به دنیای آنلاین وصل شو.");
    const clean = String(message || "").trim().slice(0, 300);
    if (!clean) return;
    const { error } = await supabase.from("world_chat").insert({
      user_id: currentUser.id,
      room_id: String(roomId).slice(0, 40),
      display_name: String(displayName || "بازیکن").trim().slice(0, 20),
      message: clean
    });
    if (error) throw error;
    if (channel) {
      await channel.send({
        type: "broadcast",
        event: "chat",
        payload: { userId: currentUser.id, displayName, message: clean }
      });
    }
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

  return { connect, saveCharacter, joinRoom, publishMove, sendChat, loadRecentChat, leave };
}
