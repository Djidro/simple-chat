// SimpleChat - Vanilla JS + Supabase
// =====================================================
// 1) Replace SUPABASE_URL and SUPABASE_ANON_KEY below.
// 2) Run the SQL from README.md in Supabase to create tables.
// =====================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = "https://rfvixnyqlgcjlohissva.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_07G3VDgwos4Dm7HHfoZJlQ_8G6tFxyw";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

// ---------- App state ----------
let currentUser = null;            // { id, email, name }
let activeConversation = null;     // { id, peer: { id, name, last_seen } }
let messageChannel = null;         // realtime channel for current chat
let presenceChannel = null;        // global presence channel
let inboxChannel = null;           // realtime channel for new conversations / messages list
let typingTimeoutLocal = null;     // debounce for "I'm typing" broadcasts
let typingHideTimeout = null;      // auto-hide peer typing indicator
let isTypingSent = false;          // last sent state to avoid spamming the channel

// =====================================================
// AUTH
// =====================================================
$("btn-signup").addEventListener("click", async () => {
  const name = $("auth-name").value.trim();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  $("auth-error").textContent = "";
  if (!name) return ($("auth-error").textContent = "Name is required for signup.");
  try {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { name } },
    });
    if (error) throw error;
    if (!data.session) {
      $("auth-error").textContent = "Check your email to confirm your account, then login.";
      return;
    }
    await ensureProfile(data.user, name);
    await onLoggedIn();
  } catch (e) {
    $("auth-error").textContent = e.message;
  }
});

$("btn-login").addEventListener("click", async () => {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  $("auth-error").textContent = "";
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await ensureProfile(data.user);
    await onLoggedIn();
  } catch (e) {
    $("auth-error").textContent = e.message;
  }
});

$("btn-logout").addEventListener("click", async () => {
  await updateLastSeen();
  await supabase.auth.signOut();
  location.reload();
});

// Insert/update row in public.users for the auth user.
async function ensureProfile(authUser, fallbackName) {
  const name =
    authUser.user_metadata?.name ||
    fallbackName ||
    authUser.email.split("@")[0];
  await supabase.from("users").upsert({
    id: authUser.id,
    email: authUser.email,
    name,
    last_seen: new Date().toISOString(),
  });
}

async function updateLastSeen() {
  if (!currentUser) return;
  await supabase.from("users")
    .update({ last_seen: new Date().toISOString() })
    .eq("id", currentUser.id);
}
window.addEventListener("beforeunload", updateLastSeen);
setInterval(updateLastSeen, 30000);

// =====================================================
// SESSION BOOTSTRAP
// =====================================================
(async function init() {
  // Ask permission for browser notifications (best-effort).
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    await ensureProfile(session.user);
    await onLoggedIn();
  } else {
    show("auth-screen");
  }
})();

async function onLoggedIn() {
  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await supabase.from("users").select("*").eq("id", user.id).single();
  currentUser = profile || { id: user.id, email: user.email, name: user.email };
  $("me-label").textContent = currentUser.name + " — " + currentUser.email;
  hide("auth-screen");
  show("list-screen");
  await loadConversations();
  subscribeInbox();
}

// =====================================================
// CONVERSATION LIST
// =====================================================
async function loadConversations() {
  const list = $("conversation-list");
  list.innerHTML = "";

  // Conversations the current user participates in.
  const { data: parts } = await supabase
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", currentUser.id);

  const ids = (parts || []).map((p) => p.conversation_id);
  if (ids.length === 0) return;

  // For each conversation, find the OTHER participant + last message.
  const { data: convs } = await supabase
    .from("conversation_participants")
    .select("conversation_id, user_id, users:user_id (id, name, email, last_seen)")
    .in("conversation_id", ids)
    .neq("user_id", currentUser.id);

  for (const row of convs || []) {
    const { data: lastMsg } = await supabase
      .from("messages")
      .select("content, created_at")
      .eq("conversation_id", row.conversation_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const li = document.createElement("li");
    const initial = (row.users.name || "?").charAt(0).toUpperCase();
    li.innerHTML = `
      <div class="avatar" data-profile="1">${initial}</div>
      <div class="conv-meta">
        <div class="name"><span data-profile="1">${escapeHtml(row.users.name)}</span>
          <span class="time">${lastMsg ? formatTime(lastMsg.created_at) : ""}</span>
        </div>
        <div class="last">${lastMsg ? escapeHtml(lastMsg.content) : "No messages yet"}</div>
      </div>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest("[data-profile]")) {
        openProfile(row.users, { id: row.conversation_id, peer: row.users });
      } else {
        openChat({ id: row.conversation_id, peer: row.users });
      }
    });
    list.appendChild(li);
  }
}

// =====================================================
// PROFILE MODAL
// =====================================================
let profileContext = null; // { conv } to open chat from "Message" button

async function openProfile(user, ctx) {
  // Re-fetch to get fresh last_seen.
  const { data: fresh } = await supabase
    .from("users").select("*").eq("id", user.id).maybeSingle();
  const u = fresh || user;
  profileContext = ctx || null;

  const avatar = $("profile-avatar");
  if (u.avatar_url) {
    avatar.style.backgroundImage = `url(${u.avatar_url})`;
    avatar.style.backgroundSize = "cover";
    avatar.textContent = "";
  } else {
    avatar.style.backgroundImage = "";
    avatar.textContent = (u.name || "?").charAt(0).toUpperCase();
  }
  $("profile-name").textContent = u.name || "Unknown";
  $("profile-email").textContent = u.email || "";
  $("profile-status").textContent = formatPresence(u.last_seen);
  $("btn-profile-message").style.display = profileContext ? "" : "none";
  show("profile-modal");
}

document.getElementById("btn-profile-close").addEventListener("click", () => {
  hide("profile-modal");
});
document.getElementById("btn-profile-message").addEventListener("click", () => {
  hide("profile-modal");
  if (profileContext) openChat(profileContext);
});

// Realtime: refresh the chat list when any new message arrives in any of my conversations.
function subscribeInbox() {
  if (inboxChannel) supabase.removeChannel(inboxChannel);
  inboxChannel = supabase
    .channel("inbox-" + currentUser.id)
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      (payload) => {
        // Only refresh if the message belongs to a conversation we're in.
        // Cheap approach: just reload list.
        loadConversations();

        // Browser notification if it's not from me and not the open chat.
        if (
          payload.new.sender_id !== currentUser.id &&
          (!activeConversation || activeConversation.id !== payload.new.conversation_id)
        ) {
          notify("New message", payload.new.content);
        }
      }
    )
    .subscribe();
}

// =====================================================
// NEW CHAT
// =====================================================
$("btn-new-chat").addEventListener("click", () => {
  $("new-chat-email").value = "";
  $("new-chat-error").textContent = "";
  show("new-chat-modal");
});
$("btn-cancel-chat").addEventListener("click", () => hide("new-chat-modal"));

$("btn-start-chat").addEventListener("click", async () => {
  const email = $("new-chat-email").value.trim().toLowerCase();
  $("new-chat-error").textContent = "";
  if (!email) return;
  if (email === currentUser.email) {
    $("new-chat-error").textContent = "You can't chat with yourself.";
    return;
  }
  try {
    const { data: peer, error } = await supabase
      .from("users").select("*").eq("email", email).maybeSingle();
    if (error) throw error;
    if (!peer) { $("new-chat-error").textContent = "User not found."; return; }

    // Find existing 1:1 conversation
    const { data: mine } = await supabase
      .from("conversation_participants")
      .select("conversation_id").eq("user_id", currentUser.id);
    const myIds = (mine || []).map(r => r.conversation_id);
    let conversationId = null;
    if (myIds.length) {
      const { data: shared } = await supabase
        .from("conversation_participants")
        .select("conversation_id")
        .eq("user_id", peer.id)
        .in("conversation_id", myIds);
      if (shared && shared.length) conversationId = shared[0].conversation_id;
    }

    // Otherwise create one
    if (!conversationId) {
      const { data: newConv, error: e1 } = await supabase
        .from("conversations").insert({}).select().single();
      if (e1) throw e1;
      conversationId = newConv.id;
      const { error: e2 } = await supabase.from("conversation_participants").insert([
        { conversation_id: conversationId, user_id: currentUser.id },
        { conversation_id: conversationId, user_id: peer.id },
      ]);
      if (e2) throw e2;
    }

    hide("new-chat-modal");
    await loadConversations();
    openChat({ id: conversationId, peer });
  } catch (e) {
    $("new-chat-error").textContent = e.message;
  }
});

// =====================================================
// CHAT ROOM
// =====================================================
$("btn-back").addEventListener("click", () => {
  sendTyping(false);
  hideTyping();
  if (messageChannel) { supabase.removeChannel(messageChannel); messageChannel = null; }
  activeConversation = null;
  hide("chat-screen");
  show("list-screen");
  loadConversations();
});

async function openChat(conv) {
  activeConversation = conv;
  $("peer-name").textContent = conv.peer.name;
  $("peer-status").textContent = formatPresence(conv.peer.last_seen);
  $("messages").innerHTML = "";
  hide("list-screen");
  show("chat-screen");

  const { data: msgs } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: true });

  for (const m of msgs || []) appendMessage(m);
  scrollToBottom();

  // Realtime subscription to this conversation's messages + typing broadcasts.
  if (messageChannel) supabase.removeChannel(messageChannel);
  messageChannel = supabase
    .channel("conv-" + conv.id)
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "messages",
        filter: `conversation_id=eq.${conv.id}` },
      (payload) => {
        appendMessage(payload.new);
        scrollToBottom();
      }
    )
    .on("broadcast", { event: "typing" }, (payload) => {
      // Ignore our own typing events.
      if (!payload.payload || payload.payload.user_id === currentUser.id) return;
      if (payload.payload.typing) showTyping();
      else hideTyping();
    })
    .subscribe();
}

$("send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("message-input");
  const content = input.value.trim();
  if (!content || !activeConversation) return;
  input.value = "";
  // Sending a message implicitly stops typing.
  sendTyping(false);
  const { error } = await supabase.from("messages").insert({
    conversation_id: activeConversation.id,
    sender_id: currentUser.id,
    content,
  });
  if (error) {
    alert("Failed to send: " + error.message);
    input.value = content;
  }
});

// Broadcast typing state on input. Sends "typing=true" once, then auto-resets
// to false after 2s of inactivity.
$("message-input").addEventListener("input", () => {
  if (!activeConversation) return;
  const hasText = $("message-input").value.trim().length > 0;
  if (hasText) {
    if (!isTypingSent) sendTyping(true);
    clearTimeout(typingTimeoutLocal);
    typingTimeoutLocal = setTimeout(() => sendTyping(false), 2000);
  } else {
    sendTyping(false);
  }
});

function sendTyping(typing) {
  if (!messageChannel) return;
  isTypingSent = typing;
  messageChannel.send({
    type: "broadcast",
    event: "typing",
    payload: { user_id: currentUser.id, typing },
  });
}

function showTyping() {
  let el = document.getElementById("typing-indicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "typing-indicator";
    el.className = "typing";
    el.innerHTML = "<span></span><span></span><span></span>";
    $("messages").appendChild(el);
    scrollToBottom();
  }
  // Safety: hide after 4s if no further events arrive.
  clearTimeout(typingHideTimeout);
  typingHideTimeout = setTimeout(hideTyping, 4000);
}

function hideTyping() {
  const el = document.getElementById("typing-indicator");
  if (el) el.remove();
  clearTimeout(typingHideTimeout);
}

function appendMessage(m) {
  const div = document.createElement("div");
  div.className = "bubble " + (m.sender_id === currentUser.id ? "me" : "them");
  div.innerHTML = `${escapeHtml(m.content)}<span class="ts">${formatTime(m.created_at)}</span>`;
  $("messages").appendChild(div);
}

function scrollToBottom() {
  const el = $("messages");
  el.scrollTop = el.scrollHeight;
}

// =====================================================
// HELPERS
// =====================================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatPresence(lastSeen) {
  if (!lastSeen) return "offline";
  const diff = Date.now() - new Date(lastSeen).getTime();
  if (diff < 60_000) return "online";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `last seen ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `last seen ${hrs}h ago`;
  return "last seen " + new Date(lastSeen).toLocaleDateString();
}

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}
