// SimpleChat v2 — Complete Working App with Profile Access Control
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://rfvixnyqlgcjlohissva.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_07G3VDgwos4Dm7HHfoZJlQ_8G6tFxyw";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// DOM helpers
const $ = (id) => document.getElementById(id);
const show = (id) => { const el = $(id); if (el) el.classList.remove("hidden"); };
const hide = (id) => { const el = $(id); if (el) el.classList.add("hidden"); };

// State
let currentUser = null;
let activeConversation = null;
let messageChannel = null;
let inboxChannel = null;
let typingTimeoutLocal = null;
let typingHideTimeout = null;
let isTypingSent = false;
let editingMessageId = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let searchTimeout = null;
let replyToMessage = null;

// ============================================
// SPLASH
// ============================================
setTimeout(() => {
  const splash = $("splash-screen");
  if (splash) splash.style.display = "none";
}, 1800);

// ============================================
// AUTH
// ============================================
$("btn-signup").addEventListener("click", async () => {
  const name = $("auth-name").value.trim();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  $("auth-error").textContent = "";
  if (!name) { $("auth-error").textContent = "Name is required."; return; }
  try {
    $("btn-signup").textContent = "Creating...";
    $("btn-signup").disabled = true;
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { name } } });
    if (error) throw error;
    if (!data.session) { $("auth-error").textContent = "Check your email to confirm."; $("btn-signup").textContent = "Create Account"; $("btn-signup").disabled = false; return; }
    await ensureProfile(data.user, name);
    await onLoggedIn();
  } catch (e) {
    $("auth-error").textContent = e.message;
    $("btn-signup").textContent = "Create Account";
    $("btn-signup").disabled = false;
  }
});

$("btn-login").addEventListener("click", async () => {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  $("auth-error").textContent = "";
  try {
    $("btn-login").textContent = "Signing in...";
    $("btn-login").disabled = true;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await ensureProfile(data.user);
    await onLoggedIn();
  } catch (e) {
    $("auth-error").textContent = e.message;
    $("btn-login").innerHTML = '<span>Sign In</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
    $("btn-login").disabled = false;
  }
});

$("btn-logout").addEventListener("click", async () => {
  await updateLastSeen();
  await supabase.auth.signOut();
  location.reload();
});

// ============================================
// PROFILE
// ============================================
async function ensureProfile(authUser, fallbackName) {
  let name = fallbackName || "";
  if (authUser.user_metadata?.name) name = authUser.user_metadata.name;
  else if (!name && authUser.email) name = authUser.email.split("@")[0];
  await supabase.from("users").upsert({
    id: authUser.id, email: authUser.email, name, last_seen: new Date().toISOString()
  }, { onConflict: "id" });
}

async function updateLastSeen() {
  if (!currentUser) return;
  await supabase.from("users").update({ last_seen: new Date().toISOString() }).eq("id", currentUser.id);
}
window.addEventListener("beforeunload", updateLastSeen);
setInterval(updateLastSeen, 30000);

// ============================================
// INIT
// ============================================
(async function init() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
  const { data } = await supabase.auth.getSession();
  if (data?.session) {
    await ensureProfile(data.session.user);
    await onLoggedIn();
  } else {
    show("auth-screen");
  }
})();

async function onLoggedIn() {
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  const { data: profile } = await supabase.from("users").select("*").eq("id", user.id).single();
  currentUser = profile || { id: user.id, email: user.email, name: user.email };
  $("me-label").textContent = currentUser.name;
  $("me-label").addEventListener("click", () => openProfile(currentUser, null));
  hide("auth-screen");
  show("list-screen");
  await loadConversations();
  subscribeInbox();
  loadAllSettings();
}

// ============================================
// CONVERSATIONS
// ============================================
async function loadConversations() {
  const list = $("conversation-list");
  list.innerHTML = '<li style="text-align:center;padding:24px;color:var(--text-muted);">Loading chats...</li>';
  const { data: parts } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", currentUser.id);
  if (!parts || parts.length === 0) {
    list.innerHTML = '<li class="empty-state"><p>No chats yet</p></li>';
    return;
  }
  const ids = parts.map(p => p.conversation_id);
  const { data: convs } = await supabase.from("conversation_participants")
    .select("conversation_id, user_id, users:user_id (id, name, email, last_seen, avatar_url)")
    .in("conversation_id", ids).neq("user_id", currentUser.id);
  if (!convs) return;
  list.innerHTML = "";
  for (const row of convs) {
    const { data: lastMsg } = await supabase.from("messages")
      .select("content, created_at, sender_id, seen")
      .eq("conversation_id", row.conversation_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const li = document.createElement("li");
    const peer = row.users;
    const initial = (peer.name || "?").charAt(0).toUpperCase();
    let lastText = "No messages yet";
    if (lastMsg) {
      if (lastMsg.content.startsWith("[image]")) lastText = "📷 Image";
      else if (lastMsg.content.startsWith("[video]")) lastText = "🎬 Video";
      else if (lastMsg.content.startsWith("[audio]")) lastText = "🎵 Voice note";
      else if (lastMsg.content.startsWith("[deleted]")) lastText = "🗑 Deleted";
      else lastText = lastMsg.content;
    }
    const isOnline = peer.last_seen && (Date.now() - new Date(peer.last_seen).getTime()) < 60000;
    const avatarStyle = peer.avatar_url ? `background-image:url(${peer.avatar_url});background-size:cover;` : "";
    li.innerHTML = `<div class="avatar" data-profile="1" style="${avatarStyle}">${peer.avatar_url ? "" : initial}${isOnline ? '<span class="online-dot"></span>' : ""}</div>
      <div class="conv-meta"><div class="name"><span>${esc(peer.name)}</span><span class="time">${lastMsg ? fmtTime(lastMsg.created_at) : ""}</span></div>
      <div class="last">${esc(lastText)}</div></div>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest("[data-profile]")) {
        openProfile(peer, { id: row.conversation_id, peer });
      } else {
        openChat({ id: row.conversation_id, peer });
      }
    });
    list.appendChild(li);
  }
}

$("search-input").addEventListener("input", function() {
  const q = this.value.toLowerCase();
  const items = document.querySelectorAll("#conversation-list li");
  items.forEach(li => {
    const name = (li.querySelector(".name span")?.textContent || "").toLowerCase();
    const last = (li.querySelector(".last")?.textContent || "").toLowerCase();
    li.style.display = (name.includes(q) || last.includes(q)) ? "" : "none";
  });
});

// ============================================
// PROFILE MODAL — WITH ACCESS CONTROL
// ============================================
let profileContext = null;

async function openProfile(user, ctx) {
  const { data: fresh } = await supabase.from("users").select("*").eq("id", user.id).maybeSingle();
  const u = fresh || user;
  profileContext = ctx || null;

  const isOwnProfile = currentUser && u.id === currentUser.id;

  const avatar = $("profile-avatar");
  const letter = avatar.querySelector(".avatar-letter-large");
  const uploadHint = avatar.querySelector(".avatar-upload-hint");
  const deleteBtn = $("btn-delete-avatar");
  const messageBtn = $("btn-profile-message");
  const bioDisplay = $("profile-bio-display");

  // Avatar
  if (u.avatar_url) {
    avatar.style.backgroundImage = `url(${u.avatar_url})`;
    avatar.style.backgroundSize = "cover";
    if (letter) letter.style.display = "none";
  } else {
    avatar.style.backgroundImage = "";
    if (letter) { letter.style.display = ""; letter.textContent = (u.name || "?").charAt(0).toUpperCase(); }
  }

  // Show/hide edit controls based on ownership
  if (isOwnProfile) {
    avatar.classList.add("clickable");
    avatar.style.cursor = "pointer";
    if (uploadHint) uploadHint.style.display = "";
    if (deleteBtn) deleteBtn.style.display = u.avatar_url ? "inline-block" : "none";
  } else {
    avatar.classList.remove("clickable");
    avatar.style.cursor = "default";
    if (uploadHint) uploadHint.style.display = "none";
    if (deleteBtn) deleteBtn.style.display = "none";
  }

  // Name
  $("profile-name").textContent = u.name || "Unknown";

  // Email
  $("profile-email").textContent = u.email || "";

  // Bio
  if (bioDisplay) {
    if (u.bio) { bioDisplay.textContent = u.bio; bioDisplay.style.display = ""; }
    else bioDisplay.style.display = "none";
  }

  // Status
  const statusBadge = $("profile-status");
  statusBadge.textContent = fmtPresence(u.last_seen);
  const isOnline = u.last_seen && (Date.now() - new Date(u.last_seen).getTime()) < 60000;
  statusBadge.className = "status-badge" + (isOnline ? "" : " offline");

  // Message button — show only for others with chat context
  if (messageBtn) {
    messageBtn.style.display = (!isOwnProfile && profileContext) ? "flex" : "none";
  }

  // Store ownership flag
  $("profile-modal").dataset.isOwnProfile = isOwnProfile ? "1" : "0";

  show("profile-modal");
}

$("btn-profile-close").addEventListener("click", () => hide("profile-modal"));
$("btn-profile-message").addEventListener("click", () => { hide("profile-modal"); if (profileContext) openChat(profileContext); });
$("profile-modal").addEventListener("click", function(e) { if (e.target === this) hide("profile-modal"); });

// Avatar upload — only for own profile
$("profile-avatar").addEventListener("click", () => {
  if ($("profile-modal").dataset.isOwnProfile !== "1") return;
  $("avatar-upload").click();
});

$("avatar-upload").addEventListener("change", async function(e) {
  const file = e.target.files[0];
  if (!file || !currentUser) return;
  const fileExt = file.name.split(".").pop();
  const fileName = currentUser.id + "." + fileExt;
  const upRes = await supabase.storage.from("avatars").upload(fileName, file, { upsert: true });
  if (upRes.error) { alert("Upload failed"); return; }
  const url = supabase.storage.from("avatars").getPublicUrl(fileName).data.publicUrl;
  await supabase.from("users").update({ avatar_url: url }).eq("id", currentUser.id);
  currentUser.avatar_url = url;
  $("profile-avatar").style.backgroundImage = `url(${url})`;
  $("profile-avatar").style.backgroundSize = "cover";
  const letter = $("profile-avatar").querySelector(".avatar-letter-large");
  if (letter) letter.style.display = "none";
  $("btn-delete-avatar").style.display = "inline-block";
  updateSettingsAvatar();
  alert("Profile picture updated!");
});

$("btn-delete-avatar").addEventListener("click", async () => {
  if (!currentUser || !confirm("Delete your profile picture?")) return;
  await supabase.from("users").update({ avatar_url: null }).eq("id", currentUser.id);
  currentUser.avatar_url = null;
  $("profile-avatar").style.backgroundImage = "";
  const letter = $("profile-avatar").querySelector(".avatar-letter-large");
  if (letter) { letter.style.display = ""; letter.textContent = (currentUser.name || "?").charAt(0).toUpperCase(); }
  $("btn-delete-avatar").style.display = "none";
  updateSettingsAvatar();
  alert("Profile picture deleted!");
});

// ============================================
// INBOX
// ============================================
function subscribeInbox() {
  if (inboxChannel) supabase.removeChannel(inboxChannel);
  inboxChannel = supabase.channel("inbox-" + currentUser.id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
      loadConversations();
      if (payload.new.sender_id !== currentUser.id && (!activeConversation || activeConversation.id !== payload.new.conversation_id)) {
        let body = payload.new.content;
        if (body.startsWith("[image]")) body = "📷 Image";
        else if (body.startsWith("[video]")) body = "🎬 Video";
        else if (body.startsWith("[audio]")) body = "🎵 Voice note";
        notify("New message", body);
      }
    }).subscribe();
}

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
}

// ============================================
// USERS
// ============================================
$("btn-users").addEventListener("click", async () => { await loadUsersList(); show("users-modal"); });
$("btn-users-close").addEventListener("click", () => hide("users-modal"));
$("users-modal").addEventListener("click", function(e) { if (e.target === this) hide("users-modal"); });

async function loadUsersList() {
  const list = $("users-list");
  list.innerHTML = '<li style="text-align:center;padding:24px;color:var(--text-muted);">Loading...</li>';
  const { data: users } = await supabase.from("users").select("*").neq("id", currentUser.id).order("name");
  if (!users || users.length === 0) { list.innerHTML = '<li class="empty-state"><p>No other users</p></li>'; return; }
  list.innerHTML = "";
  users.forEach(u => {
    const li = document.createElement("li");
    const initial = (u.name || "?").charAt(0).toUpperCase();
    const isOnline = u.last_seen && (Date.now() - new Date(u.last_seen).getTime()) < 60000;
    const avatarStyle = u.avatar_url ? `background-image:url(${u.avatar_url});background-size:cover;` : "";
    li.innerHTML = `<div class="avatar" data-profile="1" style="${avatarStyle}">${u.avatar_url ? "" : initial}${isOnline ? '<span class="online-dot"></span>' : ""}</div>
      <div class="conv-meta"><div class="name">${esc(u.name)}</div><div class="last">${fmtPresence(u.last_seen)}</div></div>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest("[data-profile]")) {
        openProfile(u, null);
      } else {
        hide("users-modal");
        startOrOpenChat(u);
      }
    });
    list.appendChild(li);
  });
}

async function startOrOpenChat(peer) {
  const { data: mine } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", currentUser.id);
  const myIds = (mine || []).map(r => r.conversation_id);
  let cid = null;
  if (myIds.length) {
    const { data: shared } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", peer.id).in("conversation_id", myIds);
    if (shared?.length) cid = shared[0].conversation_id;
  }
  if (!cid) {
    const { data: nc } = await supabase.from("conversations").insert({}).select().single();
    cid = nc.id;
    await supabase.from("conversation_participants").insert([{ conversation_id: cid, user_id: currentUser.id }, { conversation_id: cid, user_id: peer.id }]);
  }
  await loadConversations();
  openChat({ id: cid, peer });
}

// ============================================
// NEW CHAT
// ============================================
$("btn-new-chat").addEventListener("click", () => { $("new-chat-email").value = ""; $("new-chat-error").textContent = ""; show("new-chat-modal"); });
$("btn-cancel-chat").addEventListener("click", () => hide("new-chat-modal"));
$("new-chat-modal").addEventListener("click", function(e) { if (e.target === this) hide("new-chat-modal"); });
$("btn-start-chat").addEventListener("click", async () => {
  const email = $("new-chat-email").value.trim().toLowerCase();
  $("new-chat-error").textContent = "";
  if (!email) return;
  if (email === currentUser.email) { $("new-chat-error").textContent = "Can't chat with yourself."; return; }
  const { data: peer } = await supabase.from("users").select("*").eq("email", email).maybeSingle();
  if (!peer) { $("new-chat-error").textContent = "User not found."; return; }
  hide("new-chat-modal");
  await startOrOpenChat(peer);
});

// ============================================
// CHAT ROOM
// ============================================
$("btn-back").addEventListener("click", leaveChat);
async function leaveChat() {
  sendTyping(false); hideTyping(); stopRecording();
  if (messageChannel) { supabase.removeChannel(messageChannel); messageChannel = null; }
  activeConversation = null; editingMessageId = null; replyToMessage = null;
  $("reply-preview").classList.add("hidden");
  hide("chat-screen"); show("list-screen"); await loadConversations();
}

async function openChat(conv) {
  activeConversation = conv;
  const peer = conv.peer;
  $("peer-name").textContent = peer.name;
  $("peer-status").textContent = fmtPresence(peer.last_seen);
  $("peer-dot-small").style.display = (peer.last_seen && (Date.now() - new Date(peer.last_seen).getTime()) < 60000) ? "" : "none";
  const pa = $("peer-avatar-small");
  if (peer.avatar_url) {
    pa.style.backgroundImage = `url(${peer.avatar_url})`;
    pa.style.backgroundSize = "cover";
    pa.querySelector(".avatar-letter").style.display = "none";
  } else {
    pa.style.backgroundImage = "";
    pa.querySelector(".avatar-letter").style.display = "";
    pa.querySelector(".avatar-letter").textContent = (peer.name || "?").charAt(0).toUpperCase();
  }
  $("messages").innerHTML = '<div class="messages-date"><span>Loading...</span></div>';
  const s = getSettings();
  if (s.wallpaper) { $("messages").style.backgroundImage = `url(${s.wallpaper})`; $("messages").style.backgroundSize = "cover"; }
  else $("messages").style.backgroundImage = "";
  hide("list-screen"); show("chat-screen");
  setTimeout(() => scrollToBottom(), 300);
  $("btn-send").style.display = "none"; $("btn-record").style.display = "";
  $("message-input").value = ""; editingMessageId = null; replyToMessage = null;
  $("reply-preview").classList.add("hidden");
  $("btn-send").innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

  const { data: msgs } = await supabase.from("messages").select("*").eq("conversation_id", conv.id).order("created_at", { ascending: true });
  $("messages").innerHTML = "";
  let cd = "";
  if (msgs) {
    msgs.forEach(m => {
      const md = new Date(m.created_at).toLocaleDateString();
      if (md !== cd) { cd = md; appendDateDivider(m.created_at); }
      appendMessage(m);
    });
  }
  scrollToBottom();
  await markSeen(conv.id);

  if (messageChannel) supabase.removeChannel(messageChannel);
  messageChannel = supabase.channel("conv-" + conv.id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: "conversation_id=eq." + conv.id }, (payload) => {
      appendMessage(payload.new); scrollToBottom();
      if (payload.new.sender_id !== currentUser.id) markSeen(conv.id);
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter: "conversation_id=eq." + conv.id }, (payload) => updateMsgUI(payload.new))
    .on("broadcast", { event: "typing" }, (payload) => {
      if (!payload.payload || payload.payload.user_id === currentUser.id) return;
      if (payload.payload.typing) showTyping(); else hideTyping();
    }).subscribe();
}

function appendDateDivider(iso) {
  const d = new Date(iso), t = new Date(), y = new Date(t); y.setDate(y.getDate() - 1);
  let label = d.toDateString() === t.toDateString() ? "Today" : d.toDateString() === y.toDateString() ? "Yesterday" : d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  const div = document.createElement("div"); div.className = "messages-date";
  div.innerHTML = `<span>${label}</span>`; $("messages").appendChild(div);
}

async function markSeen(cid) {
  await supabase.from("messages").update({ seen: true }).eq("conversation_id", cid).neq("sender_id", currentUser.id).eq("seen", false);
}

function updateMsgUI(m) {
  const bubbles = $("messages").children;
  for (const b of bubbles) {
    if (b.dataset?.msgId == m.id) {
      const c = m.content || "";
      if (c.startsWith("[deleted]")) {
        b.innerHTML = '<em style="color:var(--text-muted);">🗑 Deleted</em><span class="ts">' + fmtTime(m.created_at) + '</span>';
        b.classList.add("deleted");
      } else {
        const te = b.querySelector(".bubble-text"); if (te) te.textContent = c;
      }
      const sc = b.querySelector(".seen-check");
      if (sc && m.seen) { sc.textContent = "✓✓"; sc.style.color = "var(--online)"; }
      break;
    }
  }
}

// ============================================
// MESSAGE ACTIONS
// ============================================
$("messages").addEventListener("click", async (e) => {
  const t = e.target;
  if (t.closest(".btn-delete-msg")) {
    const mid = t.closest(".btn-delete-msg").dataset.msgId;
    if (confirm("Delete?")) await supabase.from("messages").update({ content: "[deleted]" + Date.now() }).eq("id", mid);
  }
  if (t.closest(".btn-edit-msg")) {
    const mid = t.closest(".btn-edit-msg").dataset.msgId;
    const b = t.closest(".bubble"); const te = b.querySelector(".bubble-text");
    if (te && !te.textContent.startsWith("[image]") && !te.textContent.startsWith("[video]") && !te.textContent.startsWith("[audio]")) {
      $("message-input").value = te.textContent; editingMessageId = mid;
      $("message-input").focus(); $("btn-send").innerHTML = "✏️";
      $("btn-send").style.display = ""; $("btn-record").style.display = "none";
    }
  }
  if (t.closest(".btn-reply-msg")) {
    const mid = t.closest(".btn-reply-msg").dataset.msgId;
    const b = t.closest(".bubble"); const te = b.querySelector(".bubble-text");
    const c = te ? te.textContent : "Media";
    replyToMessage = { id: mid, content: c };
    $("reply-preview").innerHTML = `<span>↩ ${esc(c.substring(0, 40))}${c.length > 40 ? "..." : ""}</span><span class="reply-close">✕</span>`;
    $("reply-preview").classList.remove("hidden");
    $("message-input").focus();
  }
  if (t.closest(".reply-close")) { replyToMessage = null; $("reply-preview").classList.add("hidden"); }
  if (t.closest(".btn-react-msg")) {
    const mid = t.closest(".btn-react-msg").dataset.msgId;
    await toggleReaction(mid, "👍");
  }
  if (t.closest(".msg-reaction")) {
    const r = t.closest(".msg-reaction").dataset.reaction;
    const mid = t.closest(".bubble").dataset.msgId;
    await toggleReaction(mid, r);
  }
});

async function toggleReaction(msgId, emoji) {
  if (!currentUser) return;
  const { data: msg } = await supabase.from("messages").select("reactions").eq("id", msgId).single();
  let reactions = msg?.reactions || {};
  if (!reactions[emoji]) reactions[emoji] = [];
  const idx = reactions[emoji].indexOf(currentUser.id);
  if (idx > -1) reactions[emoji].splice(idx, 1);
  else reactions[emoji].push(currentUser.id);
  if (reactions[emoji].length === 0) delete reactions[emoji];
  await supabase.from("messages").update({ reactions }).eq("id", msgId);
}

// ============================================
// FILE & VOICE
// ============================================
$("btn-attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", async function(e) {
  const file = e.target.files[0]; if (!file) return; await sendFile(file); this.value = "";
});
$("btn-record").addEventListener("click", async () => { isRecording ? stopRecording() : await startRecording(); });

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    audioChunks = [];
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      const ext = mimeType.includes("webm") ? "webm" : "m4a";
      const blob = new Blob(audioChunks, { type: mimeType });
      const file = new File([blob], "voice_note." + ext, { type: mimeType });
      await sendFile(file);
      stream.getTracks().forEach(t => t.stop());
    };
    mediaRecorder.start(); isRecording = true;
    $("btn-record").classList.add("recording");
    const ind = document.createElement("div"); ind.id = "rec-indicator"; ind.className = "recording-indicator";
    ind.innerHTML = '<span class="recording-dot"></span> Recording...';
    $("messages").appendChild(ind); scrollToBottom();
  } catch (e) { alert("Microphone denied"); }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop(); isRecording = false;
    $("btn-record").classList.remove("recording");
    const ind = document.getElementById("rec-indicator"); if (ind) ind.remove();
  }
}

async function sendFile(file) {
  if (!activeConversation) return;
  const ext = file.name.split(".").pop();
  const name = Date.now() + "_" + Math.random().toString(36).substring(2) + "." + ext;
  const path = activeConversation.id + "/" + name;
  const up = await supabase.storage.from("chat-media").upload(path, file);
  if (up.error) { alert("Upload failed"); return; }
  const url = supabase.storage.from("chat-media").getPublicUrl(path).data.publicUrl;
  const type = file.type.split("/")[0];
  let content = type === "image" ? "[image]" + url : type === "video" ? "[video]" + url : "[audio]" + url;
  await supabase.from("messages").insert({ conversation_id: activeConversation.id, sender_id: currentUser.id, content });
}

// ============================================
// SEND
// ============================================
$("send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("message-input"); const content = input.value.trim();
  if (!content || !activeConversation) return;
  if (editingMessageId) {
    await supabase.from("messages").update({ content, edited: true }).eq("id", editingMessageId);
    editingMessageId = null;
    $("btn-send").innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  } else {
    const msg = { conversation_id: activeConversation.id, sender_id: currentUser.id, content };
    if (replyToMessage?.id) msg.reply_to = replyToMessage.id;
    await supabase.from("messages").insert(msg);
  }
  input.value = ""; sendTyping(false);
  $("btn-send").style.display = "none"; $("btn-record").style.display = "";
  replyToMessage = null; $("reply-preview").classList.add("hidden");
});

// ============================================
// TYPING
// ============================================
$("message-input").addEventListener("input", () => {
  if (!activeConversation) return;
  const has = $("message-input").value.trim().length > 0;
  if (has) {
    $("btn-send").style.display = ""; $("btn-record").style.display = "none";
    if (!isTypingSent) sendTyping(true);
    clearTimeout(typingTimeoutLocal); typingTimeoutLocal = setTimeout(() => sendTyping(false), 2000);
  } else {
    $("btn-send").style.display = "none"; $("btn-record").style.display = "";
    sendTyping(false);
  }
});
$("btn-send").style.display = "none"; $("btn-record").style.display = "";

function sendTyping(typing) {
  if (!messageChannel) return;
  isTypingSent = typing;
  messageChannel.send({ type: "broadcast", event: "typing", payload: { user_id: currentUser.id, typing } });
}

function showTyping() {
  let el = document.getElementById("typing-indicator");
  if (!el) {
    el = document.createElement("div"); el.id = "typing-indicator"; el.className = "typing";
    el.innerHTML = "<span></span><span></span><span></span>";
    $("messages").appendChild(el); scrollToBottom();
  }
  clearTimeout(typingHideTimeout); typingHideTimeout = setTimeout(hideTyping, 4000);
}

function hideTyping() {
  const el = document.getElementById("typing-indicator"); if (el) el.remove();
}

// ============================================
// APPEND MESSAGE
// ============================================
function appendMessage(m) {
  const div = document.createElement("div");
  div.className = "bubble " + (m.sender_id === currentUser.id ? "me" : "them");
  div.dataset.msgId = m.id;
  const content = m.content || "";
  const isDel = content.startsWith("[deleted]");
  let seen = "";
  if (m.sender_id === currentUser.id) {
    seen = `<span class="seen-check" style="color:${m.seen ? "var(--online)" : "var(--text-muted)"};">${m.seen ? "✓✓" : "✓"}</span>`;
  }
  if (isDel) {
    div.innerHTML = `${seen}<em style="color:var(--text-muted);">🗑 Deleted</em><span class="ts">${fmtTime(m.created_at)}</span>`;
    div.classList.add("deleted");
  } else if (content.startsWith("[image]")) {
    const url = content.replace("[image]", "");
    div.innerHTML = `<img src="${url}" class="msg-image" loading="lazy" />${seen}<span class="ts">${fmtTime(m.created_at)}</span>`;
    div.querySelector(".msg-image")?.addEventListener("click", () => { $("zoom-image").src = url; show("image-zoom-modal"); });
  } else if (content.startsWith("[video]")) {
    const url = content.replace("[video]", "");
    div.innerHTML = `<video controls class="msg-video" preload="metadata"><source src="${url}"></video>${seen}<span class="ts">${fmtTime(m.created_at)}</span>`;
  } else if (content.startsWith("[audio]")) {
    const url = content.replace("[audio]", "");
    div.innerHTML = `<audio controls class="msg-audio" preload="metadata"><source src="${url}"></audio>${seen}<span class="ts">${fmtTime(m.created_at)}</span>`;
  } else {
    const edited = m.edited ? ' <span class="edited-mark">(edited)</span>' : "";
    div.innerHTML = `${seen}<span class="bubble-text">${esc(content)}</span>${edited}<span class="ts">${fmtTime(m.created_at)}</span>`;
  }
  if (m.reply_to) {
    const rd = document.createElement("div");
    rd.style.cssText = "font-size:11px;color:var(--text-muted);border-left:3px solid var(--accent);padding:2px 8px;margin-bottom:4px;opacity:0.8;";
    rd.textContent = "↩ Replied";
    div.insertBefore(rd, div.firstChild);
  }
  if (m.reactions && Object.keys(m.reactions).length > 0) {
    const rdiv = document.createElement("div"); rdiv.className = "msg-reactions";
    for (const [emoji, users] of Object.entries(m.reactions)) {
      const btn = document.createElement("button");
      btn.className = "msg-reaction" + ((users || []).includes(currentUser?.id) ? " active" : "");
      btn.dataset.reaction = emoji;
      btn.innerHTML = `${emoji} <span class="reaction-count">${(users || []).length}</span>`;
      rdiv.appendChild(btn);
    }
    div.appendChild(rdiv);
  }
  if (!isDel) {
    const adiv = document.createElement("div"); adiv.className = "msg-actions";
    adiv.innerHTML = `<button class="btn-react-msg" data-msg-id="${m.id}">😊</button>
      <button class="btn-reply-msg" data-msg-id="${m.id}">↩</button>
      ${m.sender_id === currentUser.id ? `<button class="btn-edit-msg" data-msg-id="${m.id}">✏️</button><button class="btn-delete-msg" data-msg-id="${m.id}">🗑</button>` : ""}`;
    div.style.position = "relative"; div.appendChild(adiv);
  }
  $("messages").appendChild(div);
}

function scrollToBottom() {
  const el = $("messages"); if (!el) return;
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

// ============================================
// ZOOM
// ============================================
$("btn-close-zoom").addEventListener("click", () => hide("image-zoom-modal"));
$("image-zoom-modal").addEventListener("click", function(e) { if (e.target === this) hide("image-zoom-modal"); });
$("peer-info-click").addEventListener("click", () => { if (activeConversation) openProfile(activeConversation.peer, activeConversation); });

// ============================================
// SETTINGS — FULLY WORKING
// ============================================
function getSettings() {
  try { return JSON.parse(localStorage.getItem("sc_settings") || "{}"); } catch { return {}; }
}
function saveSettings(u) {
  const c = getSettings(); localStorage.setItem("sc_settings", JSON.stringify({ ...c, ...u }));
}

$("btn-settings").addEventListener("click", openSettings);
$("btn-settings-back").addEventListener("click", closeSettings);

function openSettings() {
  if (!currentUser) return;
  loadOwnProfileForSettings();
  $("settings-name").textContent = currentUser.name || "Unknown";
  $("settings-email").textContent = currentUser.email || "";
  $("settings-bio-input").value = currentUser.bio || "";
  updateSettingsAvatar();
  loadSettingsUI();
  hide("list-screen"); hide("chat-screen"); show("settings-screen");
}

function closeSettings() {
  saveBio();
  hide("settings-screen"); show("list-screen");
}

async function loadOwnProfileForSettings() {
  if (!currentUser) return;
  const { data: profile } = await supabase.from("users").select("*").eq("id", currentUser.id).single();
  if (profile) currentUser = { ...currentUser, ...profile };
}

function updateSettingsAvatar() {
  const a = $("settings-avatar");
  if (!a) return;
  if (currentUser?.avatar_url) {
    a.style.backgroundImage = `url(${currentUser.avatar_url})`;
    a.style.backgroundSize = "cover";
    const l = a.querySelector(".avatar-letter-xlarge"); if (l) l.style.display = "none";
  } else {
    a.style.backgroundImage = "";
    const l = a.querySelector(".avatar-letter-xlarge");
    if (l) { l.style.display = ""; l.textContent = (currentUser?.name || "?").charAt(0).toUpperCase(); }
  }
}

async function saveBio() {
  const bio = $("settings-bio-input").value.trim();
  if (!currentUser) return;
  try { await supabase.from("users").update({ bio }).eq("id", currentUser.id); currentUser.bio = bio; } catch (e) {}
}
$("settings-bio-input").addEventListener("blur", saveBio);
$("settings-bio-input").addEventListener("keypress", (e) => { if (e.key === "Enter") e.target.blur(); });

$("settings-avatar").addEventListener("click", () => {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
  inp.onchange = async (ev) => {
    const file = ev.target.files[0]; if (!file || !currentUser) return;
    const ext = file.name.split(".").pop();
    const fileName = currentUser.id + "." + ext;
    await supabase.storage.from("avatars").upload(fileName, file, { upsert: true });
    const url = supabase.storage.from("avatars").getPublicUrl(fileName).data.publicUrl;
    await supabase.from("users").update({ avatar_url: url }).eq("id", currentUser.id);
    currentUser.avatar_url = url;
    updateSettingsAvatar();
    showToast("Profile picture updated!");
  };
  inp.click();
});

function loadSettingsUI() {
  const s = getSettings();
  setToggle("toggle-dark-mode", s.darkMode !== false);
  setToggle("toggle-notifications", s.notifications !== false);
  setToggle("toggle-sound", s.sound !== false);
  setToggle("toggle-vibration", s.vibration !== false);
  setToggle("toggle-online-status", s.onlineStatus !== false);
  setToggle("toggle-typing-indicator", s.typingIndicator !== false);
  setToggle("toggle-read-receipts", s.readReceipts !== false);
  document.querySelectorAll(".accent-dot").forEach(d => d.classList.toggle("active", d.dataset.color === (s.accentColor || "blue")));
  $("font-size-label").textContent = s.fontSize || "Medium";
}
function setToggle(id, val) { const el = $(id); if (el) el.checked = val; }

function loadAllSettings() {
  const s = getSettings();
  if (s.fontSize) document.documentElement.style.fontSize = { "Small": "14px", "Medium": "15px", "Large": "16px", "Extra Large": "18px" }[s.fontSize] || "15px";
  applyAccent(s.accentColor || "blue");
}

$("toggle-dark-mode").addEventListener("change", function() { saveSettings({ darkMode: this.checked }); showToast(this.checked ? "Dark mode" : "Light mode"); });
$("toggle-notifications").addEventListener("change", function() { saveSettings({ notifications: this.checked }); });
$("toggle-sound").addEventListener("change", function() { saveSettings({ sound: this.checked }); });
$("toggle-vibration").addEventListener("change", function() { saveSettings({ vibration: this.checked }); if (this.checked && navigator.vibrate) navigator.vibrate(50); });
$("toggle-online-status").addEventListener("change", function() { saveSettings({ onlineStatus: this.checked }); });
$("toggle-typing-indicator").addEventListener("change", function() { saveSettings({ typingIndicator: this.checked }); });
$("toggle-read-receipts").addEventListener("change", function() { saveSettings({ readReceipts: this.checked }); });

document.querySelectorAll(".accent-dot").forEach(dot => {
  dot.addEventListener("click", function() {
    const color = this.dataset.color;
    document.querySelectorAll(".accent-dot").forEach(d => d.classList.remove("active"));
    this.classList.add("active");
    applyAccent(color);
    saveSettings({ accentColor: color });
    showToast("Accent: " + color);
  });
});

function applyAccent(color) {
  const c = {
    blue: { a: "#3b82f6", l: "#60a5fa", d: "#2563eb", g: "rgba(59,130,246,0.25)", gr: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)" },
    purple: { a: "#8b5cf6", l: "#a78bfa", d: "#7c3aed", g: "rgba(139,92,246,0.25)", gr: "linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)" },
    green: { a: "#22c55e", l: "#4ade80", d: "#16a34a", g: "rgba(34,197,94,0.25)", gr: "linear-gradient(135deg, #22c55e 0%, #10b981 100%)" },
    orange: { a: "#f59e0b", l: "#fbbf24", d: "#d97706", g: "rgba(245,158,11,0.25)", gr: "linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)" },
    pink: { a: "#ec4899", l: "#f472b6", d: "#db2777", g: "rgba(236,72,153,0.25)", gr: "linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)" }
  }[color] || { a: "#3b82f6", l: "#60a5fa", d: "#2563eb", g: "rgba(59,130,246,0.25)", gr: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)" };
  document.documentElement.style.setProperty("--accent", c.a);
  document.documentElement.style.setProperty("--accent-light", c.l);
  document.documentElement.style.setProperty("--accent-dark", c.d);
  document.documentElement.style.setProperty("--accent-glow", c.g);
  document.documentElement.style.setProperty("--accent-gradient", c.gr);
}

$("btn-font-smaller").addEventListener("click", () => {
  const sizes = ["Extra Large", "Large", "Medium", "Small"], cur = getSettings().fontSize || "Medium";
  const idx = sizes.indexOf(cur); if (idx < sizes.length - 1) {
    const ns = sizes[idx + 1]; $("font-size-label").textContent = ns;
    document.documentElement.style.fontSize = { "Small": "14px", "Medium": "15px", "Large": "16px", "Extra Large": "18px" }[ns];
    saveSettings({ fontSize: ns });
  }
});
$("btn-font-bigger").addEventListener("click", () => {
  const sizes = ["Small", "Medium", "Large", "Extra Large"], cur = getSettings().fontSize || "Medium";
  const idx = sizes.indexOf(cur); if (idx < sizes.length - 1) {
    const ns = sizes[idx + 1]; $("font-size-label").textContent = ns;
    document.documentElement.style.fontSize = { "Small": "14px", "Medium": "15px", "Large": "16px", "Extra Large": "18px" }[ns];
    saveSettings({ fontSize: ns });
  }
});

$("btn-wallpaper").addEventListener("click", () => {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
  inp.onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { saveSettings({ wallpaper: ev.target.result }); showToast("Wallpaper saved!"); };
    reader.readAsDataURL(file);
  };
  inp.click();
});

// ============================================
// CHAT SETTINGS SIDEBAR
// ============================================
$("btn-chat-settings").addEventListener("click", () => { show("chat-settings-sidebar"); loadChatSidebar(); });
$("btn-close-chat-settings").addEventListener("click", () => hide("chat-settings-sidebar"));
$("chat-settings-sidebar").addEventListener("click", function(e) { if (e.target === this) hide("chat-settings-sidebar"); });

function loadChatSidebar() {
  if (!activeConversation) return;
  const key = "sc_chat_" + activeConversation.id;
  const s = JSON.parse(localStorage.getItem(key) || "{}");
  setToggle("toggle-mute-chat", s.muted || false);
  $("media-quality-select").value = s.mediaQuality || "auto";
  $("auto-delete-label").textContent = s.autoDelete || "Off";
}
function saveChatSetting(u) {
  if (!activeConversation) return;
  const key = "sc_chat_" + activeConversation.id;
  const c = JSON.parse(localStorage.getItem(key) || "{}");
  localStorage.setItem(key, JSON.stringify({ ...c, ...u }));
}

$("toggle-mute-chat").addEventListener("change", function() { saveChatSetting({ muted: this.checked }); showToast(this.checked ? "Muted" : "Unmuted"); });
$("media-quality-select").addEventListener("change", function() { saveChatSetting({ mediaQuality: this.value }); });
$("btn-auto-delete").addEventListener("click", () => {
  const opts = ["Off", "24 hours", "7 days", "30 days"], cur = $("auto-delete-label").textContent;
  const next = opts[(opts.indexOf(cur) + 1) % opts.length];
  $("auto-delete-label").textContent = next; saveChatSetting({ autoDelete: next });
});
$("btn-clear-chat").addEventListener("click", async () => {
  if (!activeConversation || !confirm("Delete all messages?")) return;
  await supabase.from("messages").delete().eq("conversation_id", activeConversation.id);
  $("messages").innerHTML = ""; hide("chat-settings-sidebar"); showToast("Chat cleared");
});
$("btn-export-chat").addEventListener("click", async () => {
  if (!activeConversation) return;
  const { data: msgs } = await supabase.from("messages").select("*").eq("conversation_id", activeConversation.id).order("created_at");
  if (!msgs?.length) { showToast("No messages"); return; }
  let txt = `Chat: ${activeConversation.peer.name}\n${new Date().toLocaleString()}\n---\n\n`;
  msgs.forEach(m => {
    let c = m.content; if (c.startsWith("[")) c = "[Media]";
    txt += `[${fmtTime(m.created_at)}] ${m.sender_id === currentUser.id ? "Me" : activeConversation.peer.name}: ${c}\n\n`;
  });
  const blob = new Blob([txt], { type: "text/plain" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `chat_${Date.now()}.txt`; a.click();
  hide("chat-settings-sidebar"); showToast("Exported!");
});
$("btn-clear-all-chats").addEventListener("click", async () => {
  if (!confirm("Delete ALL chats?")) return;
  const { data: parts } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", currentUser.id);
  if (parts) for (const p of parts) {
    await supabase.from("messages").delete().eq("conversation_id", p.conversation_id);
    await supabase.from("conversation_participants").delete().eq("conversation_id", p.conversation_id);
    await supabase.from("conversations").delete().eq("id", p.conversation_id);
  }
  showToast("All cleared"); closeSettings(); loadConversations();
});

// ============================================
// TOAST
// ============================================
function showToast(msg) {
  const container = $("toast-container"); if (!container) return;
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => { t.classList.add("removing"); t.addEventListener("animationend", () => t.remove()); }, 2000);
}

// ============================================
// KEYBOARD FIX
// ============================================
(function() {
  if (!/Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent)) return;
  const cs = $("chat-screen"), me = $("messages"), ie = $("message-input");
  if (!cs || !me || !ie) return;
  function dims() { const vh = window.innerHeight; cs.style.height = vh + "px"; me.style.height = (vh - 120) + "px"; }
  dims();
  ie.addEventListener("focus", () => setTimeout(() => { const vh = window.innerHeight; cs.style.height = vh + "px"; me.style.height = (vh - 120) + "px"; me.scrollTop = me.scrollHeight; }, 300));
  ie.addEventListener("blur", () => setTimeout(dims, 200));
})();

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { hide("image-zoom-modal"); hide("chat-settings-sidebar"); }
});

$("btn-call").addEventListener("click", () => showToast("Calls coming soon!"));
$("btn-video-call").addEventListener("click", () => showToast("Video calls coming soon!"));

// ============================================
// HELPERS
// ============================================
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmtTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function fmtPresence(ls) {
  if (!ls) return "offline";
  const diff = Date.now() - new Date(ls).getTime();
  if (diff < 60000) return "online";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `last seen ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `last seen ${h}h ago`;
  return "last seen " + new Date(ls).toLocaleDateString();
}
