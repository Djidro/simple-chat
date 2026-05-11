// SimpleChat v2 — Complete App
// Vanilla JS + Supabase

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================
// SUPABASE CONFIGURATION
// ============================================
const SUPABASE_URL = "https://rfvixnyqlgcjlohissva.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_07G3VDgwos4Dm7HHfoZJlQ_8G6tFxyw";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ============================================
// DOM HELPERS
// ============================================
const $ = (id) => document.getElementById(id);
const $$ = (selector) => document.querySelectorAll(selector);
const show = (id) => {
  const el = $(id);
  if (el) el.classList.remove("hidden");
};
const hide = (id) => {
  const el = $(id);
  if (el) el.classList.add("hidden");
};

// ============================================
// APP STATE
// ============================================
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
let unreadCounts = {};
let searchTimeout = null;
let replyToMessage = null;

// ============================================
// SPLASH SCREEN
// ============================================
setTimeout(() => {
  const splash = $("splash-screen");
  if (splash) {
    splash.addEventListener("animationend", () => splash.remove());
  }
}, 1800);

// ============================================
// AUTHENTICATION
// ============================================
$("btn-signup").addEventListener("click", async () => {
  const name = $("auth-name").value.trim();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  $("auth-error").textContent = "";
  if (!name) {
    $("auth-error").textContent = "Name is required for signup.";
    return;
  }
  try {
    $("btn-signup").innerHTML = '<span class="spinner"></span> Creating...';
    $("btn-signup").disabled = true;
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { name } } });
    if (error) throw error;
    if (!data.session) {
      $("auth-error").textContent = "Check your email to confirm your account, then login.";
      $("btn-signup").innerHTML = "Create Account";
      $("btn-signup").disabled = false;
      return;
    }
    await ensureProfile(data.user, name);
    await onLoggedIn();
  } catch (e) {
    $("auth-error").textContent = e.message;
    $("btn-signup").innerHTML = "Create Account";
    $("btn-signup").disabled = false;
  }
});

$("btn-login").addEventListener("click", async () => {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  $("auth-error").textContent = "";
  try {
    $("btn-login").innerHTML = '<span class="spinner"></span> Signing in...';
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
// PROFILE MANAGEMENT
// ============================================
async function ensureProfile(authUser, fallbackName) {
  let name = fallbackName || "";
  if (authUser.user_metadata && authUser.user_metadata.name) name = authUser.user_metadata.name;
  else if (!name && authUser.email) name = authUser.email.split("@")[0];
  const { error } = await supabase.from("users").upsert({
    id: authUser.id,
    email: authUser.email,
    name: name,
    last_seen: new Date().toISOString(),
  }, { onConflict: "id" });
  if (error) console.error("Profile error:", error);
}

async function updateLastSeen() {
  if (!currentUser) return;
  await supabase.from("users").update({ last_seen: new Date().toISOString() }).eq("id", currentUser.id);
}
window.addEventListener("beforeunload", updateLastSeen);
setInterval(updateLastSeen, 30000);

// ============================================
// SESSION BOOTSTRAP
// ============================================
(async function init() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
  const { data } = await supabase.auth.getSession();
  if (data && data.session) {
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
  loadSettingsFromStorage();
}

// ============================================
// CONVERSATION LIST
// ============================================
async function loadConversations() {
  const list = $("conversation-list");
  list.innerHTML = '<li class="loading-state"><div class="spinner"></div><p>Loading chats...</p></li>';
  const { data: parts } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", currentUser.id);
  if (!parts || parts.length === 0) {
    list.innerHTML = '<li class="empty-state"><p>No chats yet</p><p style="font-size:12px;">Tap + to start a conversation</p></li>';
    return;
  }
  const ids = parts.map((p) => p.conversation_id);
  const { data: convs } = await supabase.from("conversation_participants").select("conversation_id, user_id, users:user_id (id, name, email, last_seen, avatar_url)").in("conversation_id", ids).neq("user_id", currentUser.id);
  if (!convs) return;
  list.innerHTML = "";
  for (const row of convs) {
    const { data: lastMsg } = await supabase.from("messages").select("content, created_at, sender_id, seen").eq("conversation_id", row.conversation_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const { count: unreadCount } = await supabase.from("messages").select("*", { count: "exact", head: true }).eq("conversation_id", row.conversation_id).eq("seen", false).neq("sender_id", currentUser.id);
    if (unreadCount > 0) unreadCounts[row.conversation_id] = unreadCount;
    const li = document.createElement("li");
    const peer = row.users;
    const userInitial = (peer.name || "?").charAt(0).toUpperCase();
    let lastText = "No messages yet";
    if (lastMsg) {
      if (lastMsg.content.startsWith("[image]")) lastText = "📷 Image";
      else if (lastMsg.content.startsWith("[video]")) lastText = "🎬 Video";
      else if (lastMsg.content.startsWith("[audio]")) lastText = "🎵 Voice note";
      else if (lastMsg.content.startsWith("[deleted]")) lastText = "🗑 Message deleted";
      else lastText = lastMsg.content;
    }
    const isOnline = peer.last_seen && Date.now() - new Date(peer.last_seen).getTime() < 60000;
    const avatarStyle = peer.avatar_url ? `background-image: url(${peer.avatar_url}); background-size: cover;` : "";
    const unreadBadge = unreadCount > 0 ? `<span class="unread-badge">${unreadCount > 99 ? "99+" : unreadCount}</span>` : "";
    li.innerHTML = `
      <div class="avatar" data-profile="1" style="${avatarStyle}">
        ${peer.avatar_url ? "" : userInitial}
        ${isOnline ? '<span class="online-dot"></span>' : ""}
      </div>
      <div class="conv-meta">
        <div class="name">
          <span data-profile="1">${escapeHtml(peer.name)}</span>
          <span class="time">${lastMsg ? formatTime(lastMsg.created_at) : ""}</span>
        </div>
        <div class="last">${unreadBadge ? unreadBadge + " " : ""}${escapeHtml(lastText)}</div>
      </div>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest("[data-profile]")) openProfile(peer, { id: row.conversation_id, peer });
      else openChat({ id: row.conversation_id, peer });
    });
    list.appendChild(li);
  }
}

// ============================================
// SEARCH
// ============================================
$("search-input").addEventListener("input", function () {
  const query = this.value.toLowerCase().trim();
  const items = $$("#conversation-list li");
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    items.forEach((li) => {
      const name = li.querySelector(".name span")?.textContent?.toLowerCase() || "";
      const last = li.querySelector(".last")?.textContent?.toLowerCase() || "";
      li.style.display = (name.includes(query) || last.includes(query)) ? "" : "none";
    });
  }, 200);
});

// ============================================
// PROFILE MODAL
// ============================================
let profileContext = null;
async function openProfile(user, ctx) {
  const { data: fresh } = await supabase.from("users").select("*").eq("id", user.id).maybeSingle();
  const u = fresh || user;
  profileContext = ctx || null;
  const avatar = $("profile-avatar");
  const avatarLetter = avatar.querySelector(".avatar-letter-large");
  const deleteBtn = $("btn-delete-avatar");
  if (u.avatar_url) {
    avatar.style.backgroundImage = `url(${u.avatar_url})`;
    avatar.style.backgroundSize = "cover";
    if (avatarLetter) avatarLetter.style.display = "none";
    if (deleteBtn) deleteBtn.style.display = "inline-block";
  } else {
    avatar.style.backgroundImage = "";
    if (avatarLetter) { avatarLetter.style.display = ""; avatarLetter.textContent = (u.name || "?").charAt(0).toUpperCase(); }
    if (deleteBtn) deleteBtn.style.display = "none";
  }
  $("profile-name").textContent = u.name || "Unknown";
  $("profile-email").textContent = u.email || "";
  const bioDisplay = $("profile-bio-display");
  if (bioDisplay) {
    if (u.bio) { bioDisplay.textContent = u.bio; bioDisplay.style.display = ""; }
    else bioDisplay.style.display = "none";
  }
  const statusBadge = $("profile-status");
  statusBadge.textContent = formatPresence(u.last_seen);
  statusBadge.className = `status-badge ${(u.last_seen && Date.now() - new Date(u.last_seen).getTime() < 60000) ? "" : "offline"}`;
  $("btn-profile-message").style.display = profileContext ? "flex" : "none";
  show("profile-modal");
}
$("btn-profile-close").addEventListener("click", () => hide("profile-modal"));
$("btn-profile-message").addEventListener("click", () => { hide("profile-modal"); if (profileContext) openChat(profileContext); });
$("profile-modal").addEventListener("click", function (e) { if (e.target === this) hide("profile-modal"); });

// Avatar upload
$("profile-avatar").addEventListener("click", (e) => { e.stopPropagation(); $("avatar-upload").click(); });
$("avatar-upload").addEventListener("change", async function (e) {
  const file = e.target.files[0];
  if (!file || !currentUser) return;
  const fileExt = file.name.split(".").pop();
  const fileName = `${currentUser.id}.${fileExt}`;
  const uploadResult = await supabase.storage.from("avatars").upload(fileName, file, { upsert: true });
  if (uploadResult.error) { alert("Upload failed: " + uploadResult.error.message); return; }
  const urlResult = supabase.storage.from("avatars").getPublicUrl(fileName);
  const avatarUrl = urlResult.data.publicUrl;
  await supabase.from("users").update({ avatar_url: avatarUrl }).eq("id", currentUser.id);
  currentUser.avatar_url = avatarUrl;
  const avatar = $("profile-avatar");
  avatar.style.backgroundImage = `url(${avatarUrl})`;
  avatar.style.backgroundSize = "cover";
  avatar.querySelector(".avatar-letter-large").style.display = "none";
  $("btn-delete-avatar").style.display = "inline-block";
  alert("Profile picture updated!");
});
$("btn-delete-avatar").addEventListener("click", async () => {
  if (!currentUser || !confirm("Delete your profile picture?")) return;
  await supabase.from("users").update({ avatar_url: null }).eq("id", currentUser.id);
  currentUser.avatar_url = null;
  const avatar = $("profile-avatar");
  avatar.style.backgroundImage = "";
  const letter = avatar.querySelector(".avatar-letter-large");
  if (letter) { letter.style.display = ""; letter.textContent = (currentUser.name || "?").charAt(0).toUpperCase(); }
  $("btn-delete-avatar").style.display = "none";
  alert("Profile picture deleted!");
});

// ============================================
// INBOX SUBSCRIPTION
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

// ============================================
// USERS LIST
// ============================================
$("btn-users").addEventListener("click", () => { loadUsersList(); show("users-modal"); });
$("btn-users-close").addEventListener("click", () => hide("users-modal"));
$("users-modal").addEventListener("click", function (e) { if (e.target === this) hide("users-modal"); });

async function loadUsersList() {
  const list = $("users-list");
  list.innerHTML = '<li class="loading-state"><div class="spinner"></div><p>Loading people...</p></li>';
  const { data: users } = await supabase.from("users").select("*").neq("id", currentUser.id).order("name", { ascending: true });
  if (!users || users.length === 0) { list.innerHTML = '<li class="empty-state"><p>No other users yet</p></li>'; return; }
  list.innerHTML = "";
  users.forEach((u) => {
    const li = document.createElement("li");
    const initial = (u.name || "?").charAt(0).toUpperCase();
    const isOnline = u.last_seen && Date.now() - new Date(u.last_seen).getTime() < 60000;
    const avatarStyle = u.avatar_url ? `background-image: url(${u.avatar_url}); background-size: cover;` : "";
    li.innerHTML = `
      <div class="avatar" style="${avatarStyle}">
        ${u.avatar_url ? "" : initial}
        ${isOnline ? '<span class="online-dot"></span>' : ""}
      </div>
      <div class="conv-meta">
        <div class="name">${escapeHtml(u.name)}</div>
        <div class="last">${formatPresence(u.last_seen)}</div>
      </div>`;
    li.addEventListener("click", async () => { hide("users-modal"); await startOrOpenChat(u); });
    list.appendChild(li);
  });
}

async function startOrOpenChat(peer) {
  const { data: mine } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", currentUser.id);
  const myIds = (mine || []).map((r) => r.conversation_id);
  let conversationId = null;
  if (myIds.length) {
    const { data: shared } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", peer.id).in("conversation_id", myIds);
    if (shared && shared.length) conversationId = shared[0].conversation_id;
  }
  if (!conversationId) {
    const { data: newConv, error } = await supabase.from("conversations").insert({}).select().single();
    if (error) { alert("Failed to create chat"); return; }
    conversationId = newConv.id;
    await supabase.from("conversation_participants").insert([{ conversation_id: conversationId, user_id: currentUser.id }, { conversation_id: conversationId, user_id: peer.id }]);
  }
  await loadConversations();
  openChat({ id: conversationId, peer });
}

// ============================================
// NEW CHAT
// ============================================
$("btn-new-chat").addEventListener("click", () => { $("new-chat-email").value = ""; $("new-chat-error").textContent = ""; show("new-chat-modal"); });
$("btn-cancel-chat").addEventListener("click", () => hide("new-chat-modal"));
$("new-chat-modal").addEventListener("click", function (e) { if (e.target === this) hide("new-chat-modal"); });

$("btn-start-chat").addEventListener("click", async () => {
  const email = $("new-chat-email").value.trim().toLowerCase();
  $("new-chat-error").textContent = "";
  if (!email) return;
  if (email === currentUser.email) { $("new-chat-error").textContent = "You can't chat with yourself."; return; }
  try {
    const { data: peer, error } = await supabase.from("users").select("*").eq("email", email).maybeSingle();
    if (error) throw error;
    if (!peer) { $("new-chat-error").textContent = "User not found."; return; }
    const { data: mine } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", currentUser.id);
    const myIds = (mine || []).map((r) => r.conversation_id);
    let conversationId = null;
    if (myIds.length) {
      const { data: shared } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", peer.id).in("conversation_id", myIds);
      if (shared && shared.length) conversationId = shared[0].conversation_id;
    }
    if (!conversationId) {
      const { data: newConv, error: e1 } = await supabase.from("conversations").insert({}).select().single();
      if (e1) throw e1;
      conversationId = newConv.id;
      const { error: e2 } = await supabase.from("conversation_participants").insert([{ conversation_id: conversationId, user_id: currentUser.id }, { conversation_id: conversationId, user_id: peer.id }]);
      if (e2) throw e2;
    }
    hide("new-chat-modal");
    await loadConversations();
    openChat({ id: conversationId, peer });
  } catch (e) { $("new-chat-error").textContent = e.message; }
});

// ============================================
// CHAT ROOM
// ============================================
$("btn-back").addEventListener("click", leaveChat);

async function leaveChat() {
  sendTyping(false); hideTyping(); stopRecording();
  if (messageChannel) { supabase.removeChannel(messageChannel); messageChannel = null; }
  activeConversation = null; editingMessageId = null; cancelReply();
  hide("chat-screen"); show("list-screen"); await loadConversations();
}

async function openChat(conv) {
  activeConversation = conv;
  const peer = conv.peer;
  $("peer-name").textContent = peer.name;
  $("peer-status").textContent = formatPresence(peer.last_seen);
  const dot = $("peer-dot-small");
  dot.style.display = (peer.last_seen && Date.now() - new Date(peer.last_seen).getTime() < 60000) ? "" : "none";
  const peerAvatar = $("peer-avatar-small");
  if (peer.avatar_url) {
    peerAvatar.style.backgroundImage = `url(${peer.avatar_url})`;
    peerAvatar.style.backgroundSize = "cover";
    peerAvatar.querySelector(".avatar-letter").style.display = "none";
  } else {
    peerAvatar.style.backgroundImage = "";
    peerAvatar.querySelector(".avatar-letter").style.display = "";
    peerAvatar.querySelector(".avatar-letter").textContent = (peer.name || "?").charAt(0).toUpperCase();
  }
  const messagesEl = $("messages");
  messagesEl.innerHTML = '<div class="messages-date"><span>Loading...</span></div>';
  
  // Load wallpaper
  const settings = getSettings();
  if (settings.wallpaper) {
    messagesEl.style.backgroundImage = `url(${settings.wallpaper})`;
    messagesEl.style.backgroundSize = "cover";
  } else {
    messagesEl.style.backgroundImage = "";
  }
  
  hide("list-screen"); show("chat-screen");
  setTimeout(() => scrollToBottom(), 300);
  showSendButton(false);
  $("message-input").value = ""; editingMessageId = null; cancelReply();
  $("btn-send").innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  
  const { data: msgs } = await supabase.from("messages").select("*").eq("conversation_id", conv.id).order("created_at", { ascending: true });
  messagesEl.innerHTML = "";
  let currentDate = "";
  if (msgs) {
    msgs.forEach((msg) => {
      const msgDate = new Date(msg.created_at).toLocaleDateString();
      if (msgDate !== currentDate) { currentDate = msgDate; appendDateDivider(msg.created_at); }
      appendMessage(msg);
    });
  }
  scrollToBottom();
  await markMessagesAsSeen(conv.id);
  
  if (messageChannel) supabase.removeChannel(messageChannel);
  messageChannel = supabase.channel("conv-" + conv.id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: "conversation_id=eq." + conv.id }, (payload) => {
      appendMessage(payload.new); scrollToBottom();
      if (payload.new.sender_id !== currentUser.id) markMessagesAsSeen(conv.id);
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter: "conversation_id=eq." + conv.id }, (payload) => updateMessageInUI(payload.new))
    .on("broadcast", { event: "typing" }, (payload) => {
      if (!payload.payload || payload.payload.user_id === currentUser.id) return;
      if (payload.payload.typing) showTyping(); else hideTyping();
    }).subscribe();
}

function appendDateDivider(isoDate) {
  const container = $("messages");
  const date = new Date(isoDate);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  let label;
  if (date.toDateString() === today.toDateString()) label = "Today";
  else if (date.toDateString() === yesterday.toDateString()) label = "Yesterday";
  else label = date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  const divider = document.createElement("div");
  divider.className = "messages-date";
  divider.innerHTML = `<span>${label}</span>`;
  container.appendChild(divider);
}

async function markMessagesAsSeen(convId) {
  await supabase.from("messages").update({ seen: true }).eq("conversation_id", convId).neq("sender_id", currentUser.id).eq("seen", false);
}

function updateMessageInUI(newMsg) {
  const bubbles = $("messages").children;
  for (const bubble of bubbles) {
    if (bubble.dataset && bubble.dataset.msgId == newMsg.id) {
      const content = newMsg.content || "";
      if (content.startsWith("[deleted]")) {
        bubble.innerHTML = '<em style="color: var(--text-muted);">🗑 Message deleted</em><span class="ts">' + formatTime(newMsg.created_at) + '</span>';
        bubble.classList.add("deleted");
      } else {
        const textEl = bubble.querySelector(".bubble-text");
        if (textEl) textEl.textContent = content;
      }
      const seenCheck = bubble.querySelector(".seen-check");
      if (seenCheck && newMsg.seen) { seenCheck.textContent = "✓✓"; seenCheck.style.color = "var(--online)"; }
      break;
    }
  }
}

// ============================================
// MESSAGE ACTIONS (React, Reply, Edit, Delete)
// ============================================
$("messages").addEventListener("click", async (e) => {
  const target = e.target;
  if (target.closest(".btn-react-msg")) {
    const msgId = target.closest(".btn-react-msg").dataset.msgId;
    await toggleReactionQuick(msgId, "👍");
  }
  if (target.closest(".btn-reply-msg")) {
    const msgId = target.closest(".btn-reply-msg").dataset.msgId;
    const bubble = target.closest(".bubble");
    const textEl = bubble.querySelector(".bubble-text");
    const content = textEl ? textEl.textContent : "Media";
    replyToMessage = { id: msgId, content };
    showReplyPreview(msgId, content);
    $("message-input").focus();
  }
  if (target.closest(".reply-close")) cancelReply();
  if (target.closest(".btn-delete-msg")) {
    const msgId = target.closest(".btn-delete-msg").dataset.msgId;
    if (confirm("Delete this message?")) {
      await supabase.from("messages").update({ content: "[deleted]" + Date.now() }).eq("id", msgId);
    }
  }
  if (target.closest(".btn-edit-msg")) {
    const msgId = target.closest(".btn-edit-msg").dataset.msgId;
    const bubble = target.closest(".bubble");
    const textEl = bubble.querySelector(".bubble-text");
    if (textEl && !textEl.textContent.startsWith("[image]") && !textEl.textContent.startsWith("[video]") && !textEl.textContent.startsWith("[audio]")) {
      $("message-input").value = textEl.textContent;
      editingMessageId = msgId;
      $("message-input").focus();
      $("btn-send").innerHTML = "✏️";
      showSendButton(true);
    }
  }
});

function showReplyPreview(msgId, content) {
  const preview = $("reply-preview");
  if (!preview) return;
  preview.innerHTML = `<span>↩ Replying to: ${escapeHtml(content.substring(0, 50))}${content.length > 50 ? "..." : ""}</span><span class="reply-close">✕</span>`;
  preview.classList.remove("hidden");
}

function cancelReply() {
  replyToMessage = null;
  const preview = $("reply-preview");
  if (preview) preview.classList.add("hidden");
}

async function toggleReactionQuick(msgId, reaction) {
  if (!currentUser) return;
  const { data: msg } = await supabase.from("messages").select("reactions").eq("id", msgId).single();
  let reactions = msg?.reactions || {};
  if (!reactions[reaction]) reactions[reaction] = [];
  const idx = reactions[reaction].indexOf(currentUser.id);
  if (idx > -1) reactions[reaction].splice(idx, 1);
  else reactions[reaction].push(currentUser.id);
  if (reactions[reaction].length === 0) delete reactions[reaction];
  await supabase.from("messages").update({ reactions }).eq("id", msgId);
}

// ============================================
// FILE UPLOAD & VOICE
// ============================================
$("btn-attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", async function (e) {
  const file = e.target.files[0];
  if (!file) return;
  await sendFile(file);
  this.value = "";
});
$("btn-record").addEventListener("click", async () => { isRecording ? stopRecording() : await startRecording(); });

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
      const file = new File([audioBlob], "voice_note.webm", { type: "audio/webm" });
      await sendFile(file);
      stream.getTracks().forEach((t) => t.stop());
    };
    mediaRecorder.start();
    isRecording = true;
    $("btn-record").classList.add("recording");
    const indicator = document.createElement("div");
    indicator.id = "recording-indicator";
    indicator.className = "recording-indicator";
    indicator.innerHTML = '<span class="recording-dot"></span> Recording...';
    $("messages").appendChild(indicator);
    scrollToBottom();
  } catch (e) { alert("Microphone access denied"); }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop(); isRecording = false;
    $("btn-record").classList.remove("recording");
    const indicator = document.getElementById("recording-indicator");
    if (indicator) indicator.remove();
  }
}

async function sendFile(file) {
  if (!activeConversation) return;
  const fileExt = file.name.split(".").pop();
  const fileName = Date.now() + "_" + Math.random().toString(36).substring(2) + "." + fileExt;
  const filePath = activeConversation.id + "/" + fileName;
  const uploadResult = await supabase.storage.from("chat-media").upload(filePath, file);
  if (uploadResult.error) { alert("Upload failed: " + uploadResult.error.message); return; }
  const urlResult = supabase.storage.from("chat-media").getPublicUrl(filePath);
  const mediaUrl = urlResult.data.publicUrl;
  const mediaType = file.type.split("/")[0];
  let content = "";
  if (mediaType === "image") content = "[image]" + mediaUrl;
  else if (mediaType === "video") content = "[video]" + mediaUrl;
  else if (mediaType === "audio") content = "[audio]" + mediaUrl;
  const { error } = await supabase.from("messages").insert({ conversation_id: activeConversation.id, sender_id: currentUser.id, content });
  if (error) alert("Failed to send: " + error.message);
}

// ============================================
// SEND MESSAGE
// ============================================
$("send-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("message-input");
  const content = input.value.trim();
  if (!content || !activeConversation) return;
  if (editingMessageId) {
    const { error } = await supabase.from("messages").update({ content, edited: true }).eq("id", editingMessageId);
    if (error) { alert("Failed to edit: " + error.message); return; }
    editingMessageId = null;
    $("btn-send").innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  } else {
    const msgData = { conversation_id: activeConversation.id, sender_id: currentUser.id, content };
    if (replyToMessage?.id) msgData.reply_to = replyToMessage.id;
    const { error } = await supabase.from("messages").insert(msgData);
    if (error) { alert("Failed to send: " + error.message); input.value = content; return; }
  }
  input.value = "";
  sendTyping(false); showSendButton(false); cancelReply();
});

// ============================================
// TYPING INDICATORS
// ============================================
$("message-input").addEventListener("input", () => {
  if (!activeConversation) return;
  const hasText = $("message-input").value.trim().length > 0;
  if (hasText) { showSendButton(true); if (!isTypingSent) sendTyping(true); clearTimeout(typingTimeoutLocal); typingTimeoutLocal = setTimeout(() => sendTyping(false), 2000); }
  else { showSendButton(false); sendTyping(false); }
});

function showSendButton(show) {
  if (show) { $("btn-send").style.display = ""; $("btn-record").style.display = "none"; }
  else { $("btn-send").style.display = "none"; $("btn-record").style.display = ""; }
}
$("btn-send").style.display = "none";
$("btn-record").style.display = "";

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
  clearTimeout(typingHideTimeout);
  typingHideTimeout = setTimeout(hideTyping, 4000);
}

function hideTyping() {
  const el = document.getElementById("typing-indicator");
  if (el) el.remove();
  clearTimeout(typingHideTimeout);
}

// ============================================
// APPEND MESSAGE TO UI
// ============================================
function appendMessage(m) {
  const div = document.createElement("div");
  div.className = "bubble " + (m.sender_id === currentUser.id ? "me" : "them");
  div.dataset.msgId = m.id;
  const content = m.content || "";
  const isDeleted = content.startsWith("[deleted]");
  let seenIcon = "";
  if (m.sender_id === currentUser.id) {
    seenIcon = `<span class="seen-check" style="color: ${m.seen ? "var(--online)" : "var(--text-muted)"};">${m.seen ? "✓✓" : "✓"}</span>`;
  }
  if (isDeleted) {
    div.innerHTML = `${seenIcon}<em style="color: var(--text-muted);">🗑 Message deleted</em><span class="ts">${formatTime(m.created_at)}</span>`;
    div.classList.add("deleted");
  } else if (content.startsWith("[image]")) {
    const url = content.replace("[image]", "");
    div.innerHTML = `<img src="${url}" class="msg-image" loading="lazy" alt="Image" />${seenIcon}<span class="ts">${formatTime(m.created_at)}</span>`;
    div.querySelector(".msg-image")?.addEventListener("click", () => { $("zoom-image").src = url; show("image-zoom-modal"); });
  } else if (content.startsWith("[video]")) {
    const url = content.replace("[video]", "");
    div.innerHTML = `<video controls class="msg-video" preload="metadata"><source src="${url}" type="video/mp4"></video>${seenIcon}<span class="ts">${formatTime(m.created_at)}</span>`;
  } else if (content.startsWith("[audio]")) {
    const url = content.replace("[audio]", "");
    div.innerHTML = `<audio controls class="msg-audio" preload="metadata"><source src="${url}" type="audio/webm"></audio>${seenIcon}<span class="ts">${formatTime(m.created_at)}</span>`;
  } else {
    const editedMark = m.edited ? ' <span class="edited-mark">(edited)</span>' : "";
    div.innerHTML = `${seenIcon}<span class="bubble-text">${escapeHtml(content)}</span>${editedMark}<span class="ts">${formatTime(m.created_at)}</span>`;
  }
  // Reply preview
  if (m.reply_to) {
    const replyDiv = document.createElement("div");
    replyDiv.className = "reply-preview-inline";
    replyDiv.style.cssText = "font-size:11px;color:var(--text-muted);border-left:3px solid var(--accent);padding:2px 8px;margin-bottom:4px;opacity:0.8;";
    replyDiv.textContent = "↩ Replied to a message";
    div.insertBefore(replyDiv, div.firstChild);
  }
  // Reactions
  if (m.reactions && Object.keys(m.reactions).length > 0) {
    const reactionsDiv = document.createElement("div");
    reactionsDiv.className = "msg-reactions";
    for (const [emoji, users] of Object.entries(m.reactions)) {
      const btn = document.createElement("button");
      btn.className = `msg-reaction${(users || []).includes(currentUser?.id) ? " active" : ""}`;
      btn.dataset.reaction = emoji;
      btn.innerHTML = `${emoji} <span class="reaction-count">${(users || []).length}</span>`;
      btn.addEventListener("click", async (e) => { e.stopPropagation(); await toggleReactionQuick(m.id, emoji); });
      reactionsDiv.appendChild(btn);
    }
    div.appendChild(reactionsDiv);
  }
  // Actions
  if (m.sender_id === currentUser.id && !isDeleted) {
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "msg-actions";
    actionsDiv.innerHTML = `
      <button class="btn-react-msg" data-msg-id="${m.id}" title="React">😊</button>
      <button class="btn-reply-msg" data-msg-id="${m.id}" title="Reply">↩</button>
      <button class="btn-edit-msg" data-msg-id="${m.id}" title="Edit">✏️</button>
      <button class="btn-delete-msg" data-msg-id="${m.id}" title="Delete">🗑</button>`;
    div.style.position = "relative";
    div.appendChild(actionsDiv);
  } else if (!isDeleted) {
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "msg-actions";
    actionsDiv.innerHTML = `
      <button class="btn-react-msg" data-msg-id="${m.id}" title="React">😊</button>
      <button class="btn-reply-msg" data-msg-id="${m.id}" title="Reply">↩</button>`;
    div.style.position = "relative";
    div.appendChild(actionsDiv);
  }
  $("messages").appendChild(div);
}

function scrollToBottom() {
  const el = $("messages");
  if (!el) return;
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

// ============================================
// IMAGE ZOOM
// ============================================
$("btn-close-zoom").addEventListener("click", () => hide("image-zoom-modal"));
$("image-zoom-modal").addEventListener("click", function (e) { if (e.target === this) hide("image-zoom-modal"); });

// ============================================
// PEER INFO CLICK
// ============================================
$("peer-info-click").addEventListener("click", () => {
  if (activeConversation) openProfile(activeConversation.peer, activeConversation);
});

// ============================================
// SETTINGS SCREEN
// ============================================
$("btn-settings").addEventListener("click", openSettings);
$("btn-settings-back").addEventListener("click", closeSettings);

function openSettings() {
  if (currentUser) {
    $("settings-name").textContent = currentUser.name || "Unknown";
    $("settings-email").textContent = currentUser.email || "";
    $("settings-bio-input").value = currentUser.bio || "";
    const settingsAvatar = $("settings-avatar");
    if (currentUser.avatar_url) {
      settingsAvatar.style.backgroundImage = `url(${currentUser.avatar_url})`;
      settingsAvatar.style.backgroundSize = "cover";
      settingsAvatar.querySelector(".avatar-letter-xlarge").style.display = "none";
    } else {
      settingsAvatar.style.backgroundImage = "";
      settingsAvatar.querySelector(".avatar-letter-xlarge").style.display = "";
      settingsAvatar.querySelector(".avatar-letter-xlarge").textContent = (currentUser.name || "?").charAt(0).toUpperCase();
    }
  }
  loadSettingsState();
  hide("list-screen"); hide("chat-screen"); show("settings-screen");
}

function closeSettings() {
  saveBio();
  hide("settings-screen"); show("list-screen");
}

async function saveBio() {
  const bio = $("settings-bio-input").value.trim();
  if (!currentUser) return;
  try { await supabase.from("users").update({ bio }).eq("id", currentUser.id); currentUser.bio = bio; } catch (e) { console.error(e); }
}
$("settings-bio-input").addEventListener("blur", saveBio);
$("settings-bio-input").addEventListener("keypress", (e) => { if (e.key === "Enter") e.target.blur(); });

$("settings-avatar").addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file"; input.accept = "image/*";
  input.onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file || !currentUser) return;
    const fileExt = file.name.split(".").pop();
    const fileName = `${currentUser.id}.${fileExt}`;
    const uploadResult = await supabase.storage.from("avatars").upload(fileName, file, { upsert: true });
    if (uploadResult.error) { showToast("Upload failed", "error"); return; }
    const urlResult = supabase.storage.from("avatars").getPublicUrl(fileName);
    const avatarUrl = urlResult.data.publicUrl;
    await supabase.from("users").update({ avatar_url: avatarUrl }).eq("id", currentUser.id);
    currentUser.avatar_url = avatarUrl;
    const avatar = $("settings-avatar");
    avatar.style.backgroundImage = `url(${avatarUrl})`;
    avatar.style.backgroundSize = "cover";
    avatar.querySelector(".avatar-letter-xlarge").style.display = "none";
    showToast("Profile picture updated!", "success");
  };
  input.click();
});

// ============================================
// SETTINGS TOGGLES & PREFERENCES
// ============================================
function getSettings() {
  try { return JSON.parse(localStorage.getItem("simplechat_settings") || "{}"); } catch { return {}; }
}
function saveSettings(updates) {
  const current = getSettings();
  localStorage.setItem("simplechat_settings", JSON.stringify({ ...current, ...updates }));
}

function loadSettingsState() {
  const s = getSettings();
  setToggle("toggle-dark-mode", s.darkMode !== false);
  setToggle("toggle-notifications", s.notifications !== false);
  setToggle("toggle-sound", s.sound !== false);
  setToggle("toggle-vibration", s.vibration !== false);
  setToggle("toggle-online-status", s.onlineStatus !== false);
  setToggle("toggle-typing-indicator", s.typingIndicator !== false);
  setToggle("toggle-read-receipts", s.readReceipts !== false);
  document.querySelectorAll(".accent-dot").forEach(d => d.classList.toggle("active", d.dataset.color === (s.accentColor || "blue")));
  const fontSize = s.fontSize || "Medium";
  $("font-size-label").textContent = fontSize;
  document.documentElement.style.fontSize = getFontSizeValue(fontSize);
}
function setToggle(id, val) { const el = $(id); if (el) el.checked = val; }
function getFontSizeValue(s) { return { "Small": "14px", "Medium": "15px", "Large": "16px", "Extra Large": "18px" }[s] || "15px"; }

function loadSettingsFromStorage() {
  const s = getSettings();
  if (s.fontSize) document.documentElement.style.fontSize = getFontSizeValue(s.fontSize);
  setAccentCSS(s.accentColor || "blue");
}

$("toggle-dark-mode").addEventListener("change", function() { saveSettings({ darkMode: this.checked }); });
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
    setAccentCSS(color);
    saveSettings({ accentColor: color });
    showToast(`Accent: ${color}`, "success");
  });
});

function setAccentCSS(color) {
  const colors = {
    blue: { accent: "#3b82f6", light: "#60a5fa", dark: "#2563eb", glow: "rgba(59,130,246,0.25)", gradient: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)" },
    purple: { accent: "#8b5cf6", light: "#a78bfa", dark: "#7c3aed", glow: "rgba(139,92,246,0.25)", gradient: "linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)" },
    green: { accent: "#22c55e", light: "#4ade80", dark: "#16a34a", glow: "rgba(34,197,94,0.25)", gradient: "linear-gradient(135deg, #22c55e 0%, #10b981 100%)" },
    orange: { accent: "#f59e0b", light: "#fbbf24", dark: "#d97706", glow: "rgba(245,158,11,0.25)", gradient: "linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)" },
    pink: { accent: "#ec4899", light: "#f472b6", dark: "#db2777", glow: "rgba(236,72,153,0.25)", gradient: "linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)" }
  };
  const c = colors[color] || colors.blue;
  document.documentElement.style.setProperty("--accent", c.accent);
  document.documentElement.style.setProperty("--accent-light", c.light);
  document.documentElement.style.setProperty("--accent-dark", c.dark);
  document.documentElement.style.setProperty("--accent-glow", c.glow);
  document.documentElement.style.setProperty("--accent-gradient", c.gradient);
}

$("btn-font-smaller").addEventListener("click", () => {
  const sizes = ["Extra Large", "Large", "Medium", "Small"];
  const current = getSettings().fontSize || "Medium";
  const idx = sizes.indexOf(current);
  if (idx < sizes.length - 1) { const ns = sizes[idx + 1]; $("font-size-label").textContent = ns; document.documentElement.style.fontSize = getFontSizeValue(ns); saveSettings({ fontSize: ns }); }
});
$("btn-font-bigger").addEventListener("click", () => {
  const sizes = ["Small", "Medium", "Large", "Extra Large"];
  const current = getSettings().fontSize || "Medium";
  const idx = sizes.indexOf(current);
  if (idx < sizes.length - 1) { const ns = sizes[idx + 1]; $("font-size-label").textContent = ns; document.documentElement.style.fontSize = getFontSizeValue(ns); saveSettings({ fontSize: ns }); }
});
$("btn-wallpaper").addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file"; input.accept = "image/*";
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const bg = ev.target.result;
      saveSettings({ wallpaper: bg });
      const msgs = document.querySelector("#chat-screen .messages");
      if (msgs) { msgs.style.backgroundImage = `url(${bg})`; msgs.style.backgroundSize = "cover"; }
      showToast("Wallpaper updated!", "success");
    };
    reader.readAsDataURL(file);
  };
  input.click();
});

// ============================================
// CHAT SETTINGS SIDEBAR
// ============================================
$("btn-chat-settings").addEventListener("click", openChatSettings);
$("btn-close-chat-settings").addEventListener("click", closeChatSettings);
$("chat-settings-sidebar").addEventListener("click", function(e) { if (e.target === this) closeChatSettings(); });

function openChatSettings() { show("chat-settings-sidebar"); loadChatSettingsState(); }
function closeChatSettings() { hide("chat-settings-sidebar"); }

function loadChatSettingsState() {
  if (!activeConversation) return;
  const s = getChatSettings();
  setToggle("toggle-mute-chat", s.muted || false);
  $("media-quality-select").value = s.mediaQuality || "auto";
  $("auto-delete-label").textContent = s.autoDelete || "Off";
}
function getChatSettings() {
  if (!activeConversation) return {};
  try { return JSON.parse(localStorage.getItem(`chat_settings_${activeConversation.id}`) || "{}"); } catch { return {}; }
}
function saveChatSettings(updates) {
  if (!activeConversation) return;
  const c = getChatSettings();
  localStorage.setItem(`chat_settings_${activeConversation.id}`, JSON.stringify({ ...c, ...updates }));
}

$("toggle-mute-chat").addEventListener("change", function() { saveChatSettings({ muted: this.checked }); showToast(this.checked ? "Chat muted" : "Chat unmuted", "success"); });
$("media-quality-select").addEventListener("change", function() { saveChatSettings({ mediaQuality: this.value }); });
$("btn-auto-delete").addEventListener("click", () => {
  const opts = ["Off", "24 hours", "7 days", "30 days"];
  const cur = $("auto-delete-label").textContent;
  const next = opts[(opts.indexOf(cur) + 1) % opts.length];
  $("auto-delete-label").textContent = next;
  saveChatSettings({ autoDelete: next });
  showToast(`Auto-delete: ${next}`, "success");
});
$("btn-clear-chat").addEventListener("click", async () => {
  if (!activeConversation || !confirm("Delete all messages in this chat?")) return;
  await supabase.from("messages").delete().eq("conversation_id", activeConversation.id);
  $("messages").innerHTML = "";
  showToast("Chat cleared", "success"); closeChatSettings();
});
$("btn-export-chat").addEventListener("click", async () => {
  if (!activeConversation) return;
  const { data: msgs } = await supabase.from("messages").select("*").eq("conversation_id", activeConversation.id).order("created_at", { ascending: true });
  if (!msgs || msgs.length === 0) { showToast("No messages to export", "error"); return; }
  let text = `Chat with ${activeConversation.peer.name}\nExported: ${new Date().toLocaleString()}\n${"─".repeat(40)}\n\n`;
  msgs.forEach(m => {
    const sender = m.sender_id === currentUser.id ? "You" : activeConversation.peer.name;
    let c = m.content;
    if (c.startsWith("[image]")) c = "[Image]";
    if (c.startsWith("[video]")) c = "[Video]";
    if (c.startsWith("[audio]")) c = "[Voice]";
    if (c.startsWith("[deleted]")) c = "[Deleted]";
    text += `[${new Date(m.created_at).toLocaleString()}] ${sender}:\n${c}\n\n`;
  });
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `chat_${activeConversation.peer.name}_${Date.now()}.txt`; a.click();
  URL.revokeObjectURL(url);
  showToast("Chat exported!", "success"); closeChatSettings();
});
$("btn-clear-all-chats").addEventListener("click", async () => {
  if (!confirm("Delete ALL conversations and messages? This cannot be undone.")) return;
  if (!confirm("Are you absolutely sure?")) return;
  const { data: parts } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", currentUser.id);
  if (parts) {
    for (const p of parts) {
      await supabase.from("messages").delete().eq("conversation_id", p.conversation_id);
      await supabase.from("conversation_participants").delete().eq("conversation_id", p.conversation_id);
      await supabase.from("conversations").delete().eq("id", p.conversation_id);
    }
  }
  showToast("All chats cleared", "success"); closeSettings(); loadConversations();
});

// ============================================
// TOAST SYSTEM
// ============================================
function showToast(message, type = "") {
  const container = $("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add("removing"); toast.addEventListener("animationend", () => toast.remove()); }, 2500);
}

// ============================================
// MOBILE KEYBOARD FIX
// ============================================
(function () {
  const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
  if (!isMobile) return;
  const chatScreen = $("chat-screen"), messagesEl = $("messages"), inputEl = $("message-input");
  if (!chatScreen || !messagesEl || !inputEl) return;
  function setDims() { const vh = window.innerHeight; chatScreen.style.height = vh + "px"; messagesEl.style.height = (vh - 120) + "px"; }
  setDims();
  inputEl.addEventListener("focus", () => setTimeout(() => { const vh = window.innerHeight; chatScreen.style.height = vh + "px"; messagesEl.style.height = (vh - 120) + "px"; messagesEl.scrollTop = messagesEl.scrollHeight; window.scrollTo(0, 0); }, 300));
  inputEl.addEventListener("blur", () => setTimeout(() => { setDims(); window.scrollTo(0, 0); }, 200));
})();

// ============================================
// ESCAPE KEY
// ============================================
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { hide("image-zoom-modal"); hide("chat-settings-sidebar"); } });

// ============================================
// PLACEHOLDERS
// ============================================
$("btn-call").addEventListener("click", () => showToast("Voice calls coming soon!", ""));
$("btn-video-call").addEventListener("click", () => showToast("Video calls coming soon!", ""));

// ============================================
// HELPERS
// ============================================
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function formatTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function formatPresence(lastSeen) {
  if (!lastSeen) return "offline";
  const diff = Date.now() - new Date(lastSeen).getTime();
  if (diff < 60000) return "online";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `last seen ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `last seen ${hrs}h ago`;
  return "last seen " + new Date(lastSeen).toLocaleDateString();
}
function notify(title, body) { if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body }); }

console.log("✅ SimpleChat v2 ready");
