// SimpleChat v2 — Modern Premium Messaging App
// Vanilla JS + Supabase

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================
// SUPABASE CONFIGURATION
// ============================================
const SUPABASE_URL = "https://rfvixnyqlgcjlohissva.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_07G3VDgwos4Dm7HHfoZJlQ_8G6tFxyw";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
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
const toggle = (id) => {
  const el = $(id);
  if (el) el.classList.toggle("hidden");
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

// ============================================
// SPLASH SCREEN
// ============================================
setTimeout(() => {
  const splash = $("splash-screen");
  if (splash) {
    splash.addEventListener("animationend", () => {
      splash.remove();
    });
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
    shakeElement($("auth-name"));
    return;
  }

  try {
    $("btn-signup").innerHTML = '<span class="spinner"></span> Creating...';
    $("btn-signup").disabled = true;

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } },
    });

    if (error) throw error;

    if (!data.session) {
      $("auth-error").textContent =
        "Check your email to confirm your account, then login.";
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

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;
    await ensureProfile(data.user);
    await onLoggedIn();
  } catch (e) {
    $("auth-error").textContent = e.message;
    $("btn-login").innerHTML =
      '<span>Sign In</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
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
  if (authUser.user_metadata && authUser.user_metadata.name) {
    name = authUser.user_metadata.name;
  } else if (!name && authUser.email) {
    name = authUser.email.split("@")[0];
  }

  const { error } = await supabase.from("users").upsert(
    {
      id: authUser.id,
      email: authUser.email,
      name: name,
      last_seen: new Date().toISOString(),
    },
    { onConflict: "id" }
  );

  if (error) {
    console.error("Profile error:", error);
  }
}

async function updateLastSeen() {
  if (!currentUser) return;
  await supabase
    .from("users")
    .update({ last_seen: new Date().toISOString() })
    .eq("id", currentUser.id);
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
  const { data: profile } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();

  currentUser = profile || {
    id: user.id,
    email: user.email,
    name: user.email,
  };

  $("me-label").textContent = currentUser.name;
  $("me-label").addEventListener("click", () => {
    openProfile(currentUser, null);
  });

  hide("auth-screen");
  show("list-screen");
  await loadConversations();
  subscribeInbox();
}

// ============================================
// CONVERSATION LIST
// ============================================
async function loadConversations() {
  const list = $("conversation-list");
  list.innerHTML =
    '<li class="loading-state"><div class="spinner"></div><p>Loading chats...</p></li>';

  const { data: parts } = await supabase
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", currentUser.id);

  if (!parts || parts.length === 0) {
    list.innerHTML =
      '<li class="empty-state"><p>No chats yet</p><p style="font-size:12px;">Tap + to start a conversation</p></li>';
    return;
  }

  const ids = parts.map((p) => p.conversation_id);

  const { data: convs } = await supabase
    .from("conversation_participants")
    .select("conversation_id, user_id, users:user_id (id, name, email, last_seen, avatar_url)")
    .in("conversation_id", ids)
    .neq("user_id", currentUser.id);

  if (!convs) return;

  list.innerHTML = "";

  for (const row of convs) {
    const { data: lastMsg } = await supabase
      .from("messages")
      .select("content, created_at, sender_id, seen")
      .eq("conversation_id", row.conversation_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Count unread
    const { count: unreadCount } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("conversation_id", row.conversation_id)
      .eq("seen", false)
      .neq("sender_id", currentUser.id);
    
    if (unreadCount > 0) {
      unreadCounts[row.conversation_id] = unreadCount;
    }

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

    const isOnline =
      peer.last_seen && Date.now() - new Date(peer.last_seen).getTime() < 60000;

    const avatarStyle = peer.avatar_url
      ? `background-image: url(${peer.avatar_url}); background-size: cover;`
      : "";

    const unreadBadge =
      unreadCount > 0
        ? `<span class="unread-badge">${unreadCount > 99 ? "99+" : unreadCount}</span>`
        : "";

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
        <div class="last">
          ${unreadBadge ? unreadBadge + " " : ""}${escapeHtml(lastText)}
        </div>
      </div>
    `;

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

// ============================================
// SEARCH FUNCTIONALITY
// ============================================
$("search-input").addEventListener("input", function () {
  const query = this.value.toLowerCase().trim();
  const items = $$("#conversation-list li");

  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    items.forEach((li) => {
      const name = li.querySelector(".name span")?.textContent?.toLowerCase() || "";
      const last = li.querySelector(".last")?.textContent?.toLowerCase() || "";
      if (name.includes(query) || last.includes(query)) {
        li.style.display = "";
      } else {
        li.style.display = "none";
      }
    });
  }, 200);
});

// ============================================
// PROFILE MODAL
// ============================================
let profileContext = null;

async function openProfile(user, ctx) {
  const { data: fresh } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

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
    avatar.style.backgroundSize = "";
    if (avatarLetter) {
      avatarLetter.style.display = "";
      avatarLetter.textContent = (u.name || "?").charAt(0).toUpperCase();
    }
    if (deleteBtn) deleteBtn.style.display = "none";
  }

  $("profile-name").textContent = u.name || "Unknown";
  $("profile-email").textContent = u.email || "";

  const statusBadge = $("profile-status");
  statusBadge.textContent = formatPresence(u.last_seen);
  const isOnline =
    u.last_seen && Date.now() - new Date(u.last_seen).getTime() < 60000;
  statusBadge.className = `status-badge ${isOnline ? "" : "offline"}`;

  const messageBtn = $("btn-profile-message");
  messageBtn.style.display = profileContext ? "flex" : "none";

  show("profile-modal");
}

$("btn-profile-close").addEventListener("click", () => hide("profile-modal"));
$("btn-profile-message").addEventListener("click", () => {
  hide("profile-modal");
  if (profileContext) openChat(profileContext);
});

// Close modal on overlay click
$("profile-modal").addEventListener("click", function (e) {
  if (e.target === this) hide("profile-modal");
});

// ============================================
// AVATAR UPLOAD
// ============================================
$("profile-avatar").addEventListener("click", (e) => {
  e.stopPropagation();
  $("avatar-upload").click();
});

$("avatar-upload").addEventListener("change", async function (e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!currentUser) {
    alert("You must be logged in to upload a picture.");
    return;
  }

  const fileExt = file.name.split(".").pop();
  const fileName = `${currentUser.id}.${fileExt}`;

  const uploadResult = await supabase.storage
    .from("avatars")
    .upload(fileName, file, { upsert: true });

  if (uploadResult.error) {
    alert("Upload failed: " + uploadResult.error.message);
    return;
  }

  const urlResult = supabase.storage.from("avatars").getPublicUrl(fileName);
  const avatarUrl = urlResult.data.publicUrl;

  const updateResult = await supabase
    .from("users")
    .update({ avatar_url: avatarUrl })
    .eq("id", currentUser.id);

  if (updateResult.error) {
    alert("Failed to save avatar: " + updateResult.error.message);
    return;
  }

  const avatar = $("profile-avatar");
  avatar.style.backgroundImage = `url(${avatarUrl})`;
  avatar.style.backgroundSize = "cover";
  const avatarLetter = avatar.querySelector(".avatar-letter-large");
  if (avatarLetter) avatarLetter.style.display = "none";
  $("btn-delete-avatar").style.display = "inline-block";

  alert("Profile picture updated!");
});

$("btn-delete-avatar").addEventListener("click", async () => {
  if (!currentUser) return;
  if (!confirm("Delete your profile picture?")) return;

  await supabase.from("users").update({ avatar_url: null }).eq("id", currentUser.id);

  const avatar = $("profile-avatar");
  avatar.style.backgroundImage = "";
  avatar.style.backgroundSize = "";
  const avatarLetter = avatar.querySelector(".avatar-letter-large");
  if (avatarLetter) {
    avatarLetter.style.display = "";
    avatarLetter.textContent = (currentUser.name || "?").charAt(0).toUpperCase();
  }
  $("btn-delete-avatar").style.display = "none";
  alert("Profile picture deleted!");
});

// ============================================
// INBOX SUBSCRIPTION
// ============================================
function subscribeInbox() {
  if (inboxChannel) supabase.removeChannel(inboxChannel);

  inboxChannel = supabase
    .channel("inbox-" + currentUser.id)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      (payload) => {
        loadConversations();
        if (
          payload.new.sender_id !== currentUser.id &&
          (!activeConversation ||
            activeConversation.id !== payload.new.conversation_id)
        ) {
          let notifBody = payload.new.content;
          if (notifBody.startsWith("[image]")) notifBody = "📷 Image";
          else if (notifBody.startsWith("[video]")) notifBody = "🎬 Video";
          else if (notifBody.startsWith("[audio]")) notifBody = "🎵 Voice note";
          notify("New message", notifBody);
        }
      }
    )
    .subscribe();
}

// ============================================
// USERS LIST
// ============================================
$("btn-users").addEventListener("click", () => {
  loadUsersList();
  show("users-modal");
});

$("btn-users-close").addEventListener("click", () => hide("users-modal"));
$("users-modal").addEventListener("click", function (e) {
  if (e.target === this) hide("users-modal");
});

async function loadUsersList() {
  const list = $("users-list");
  list.innerHTML =
    '<li class="loading-state"><div class="spinner"></div><p>Loading people...</p></li>';

  const { data: users } = await supabase
    .from("users")
    .select("*")
    .neq("id", currentUser.id)
    .order("name", { ascending: true });

  if (!users || users.length === 0) {
    list.innerHTML =
      '<li class="empty-state"><p>No other users yet</p></li>';
    return;
  }

  list.innerHTML = "";

  users.forEach((u) => {
    const li = document.createElement("li");
    const initial = (u.name || "?").charAt(0).toUpperCase();
    const isOnline =
      u.last_seen && Date.now() - new Date(u.last_seen).getTime() < 60000;
    const status = formatPresence(u.last_seen);

    const avatarStyle = u.avatar_url
      ? `background-image: url(${u.avatar_url}); background-size: cover;`
      : "";

    li.innerHTML = `
      <div class="avatar" style="${avatarStyle}">
        ${u.avatar_url ? "" : initial}
        ${isOnline ? '<span class="online-dot"></span>' : ""}
      </div>
      <div class="conv-meta">
        <div class="name">${escapeHtml(u.name)}</div>
        <div class="last">${status}</div>
      </div>
    `;

    li.addEventListener("click", async () => {
      hide("users-modal");
      await startOrOpenChat(u);
    });

    list.appendChild(li);
  });
}

async function startOrOpenChat(peer) {
  const { data: myConversations } = await supabase
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", currentUser.id);

  const myIds = (myConversations || []).map((r) => r.conversation_id);
  let conversationId = null;

  if (myIds.length > 0) {
    const { data: shared } = await supabase
      .from("conversation_participants")
      .select("conversation_id")
      .eq("user_id", peer.id)
      .in("conversation_id", myIds);

    if (shared && shared.length > 0) {
      conversationId = shared[0].conversation_id;
    }
  }

  if (!conversationId) {
    const { data: newConv, error } = await supabase
      .from("conversations")
      .insert({})
      .select()
      .single();

    if (error) {
      alert("Failed to create chat");
      return;
    }

    conversationId = newConv.id;

    await supabase.from("conversation_participants").insert([
      { conversation_id: conversationId, user_id: currentUser.id },
      { conversation_id: conversationId, user_id: peer.id },
    ]);
  }

  await loadConversations();
  openChat({ id: conversationId, peer });
}

// ============================================
// NEW CHAT
// ============================================
$("btn-new-chat").addEventListener("click", () => {
  $("new-chat-email").value = "";
  $("new-chat-error").textContent = "";
  show("new-chat-modal");
});

$("btn-cancel-chat").addEventListener("click", () => hide("new-chat-modal"));
$("new-chat-modal").addEventListener("click", function (e) {
  if (e.target === this) hide("new-chat-modal");
});

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
      .from("users")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (error) throw error;
    if (!peer) {
      $("new-chat-error").textContent = "User not found.";
      return;
    }

    const { data: myConversations } = await supabase
      .from("conversation_participants")
      .select("conversation_id")
      .eq("user_id", currentUser.id);

    const myIds = (myConversations || []).map((r) => r.conversation_id);
    let conversationId = null;

    if (myIds.length) {
      const { data: shared } = await supabase
        .from("conversation_participants")
        .select("conversation_id")
        .eq("user_id", peer.id)
        .in("conversation_id", myIds);

      if (shared && shared.length) conversationId = shared[0].conversation_id;
    }

    if (!conversationId) {
      const { data: newConv, error: e1 } = await supabase
        .from("conversations")
        .insert({})
        .select()
        .single();

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

// ============================================
// CHAT ROOM
// ============================================
$("btn-back").addEventListener("click", leaveChat);

async function leaveChat() {
  sendTyping(false);
  hideTyping();
  stopRecording();

  if (messageChannel) {
    supabase.removeChannel(messageChannel);
    messageChannel = null;
  }

  activeConversation = null;
  editingMessageId = null;
  hide("chat-screen");
  show("list-screen");
  await loadConversations();
}

async function openChat(conv) {
  activeConversation = conv;
  const peer = conv.peer;

  $("peer-name").textContent = peer.name;

  const isOnline =
    peer.last_seen && Date.now() - new Date(peer.last_seen).getTime() < 60000;
  $("peer-status").textContent = formatPresence(peer.last_seen);

  const dot = $("peer-dot-small");
  dot.style.display = isOnline ? "" : "none";

  // Update peer avatar
  const peerAvatar = $("peer-avatar-small");
  if (peer.avatar_url) {
    peerAvatar.style.backgroundImage = `url(${peer.avatar_url})`;
    peerAvatar.style.backgroundSize = "cover";
    peerAvatar.querySelector(".avatar-letter").style.display = "none";
  } else {
    peerAvatar.style.backgroundImage = "";
    peerAvatar.querySelector(".avatar-letter").style.display = "";
    peerAvatar.querySelector(".avatar-letter").textContent = (
      peer.name || "?"
    ).charAt(0).toUpperCase();
  }

  $("messages").innerHTML = '<div class="messages-date"><span>Loading...</span></div>';
  hide("list-screen");
  show("chat-screen");

  setTimeout(() => scrollToBottom(), 300);

  showSendButton(false);
  $("message-input").value = "";
  editingMessageId = null;
  $("btn-send").innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

  const { data: msgs } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: true });

  $("messages").innerHTML = "";

  let currentDate = "";

  if (msgs) {
    msgs.forEach((msg) => {
      const msgDate = new Date(msg.created_at).toLocaleDateString();
      if (msgDate !== currentDate) {
        currentDate = msgDate;
        appendDateDivider(msg.created_at);
      }
      appendMessage(msg);
    });
  }

  scrollToBottom();

  // Mark as seen
  await markMessagesAsSeen(conv.id);

  // Subscribe to real-time
  if (messageChannel) supabase.removeChannel(messageChannel);

  messageChannel = supabase
    .channel("conv-" + conv.id)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: "conversation_id=eq." + conv.id,
      },
      (payload) => {
        appendMessage(payload.new);
        scrollToBottom();
        if (payload.new.sender_id !== currentUser.id) {
          markMessagesAsSeen(conv.id);
        }
      }
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "messages",
        filter: "conversation_id=eq." + conv.id,
      },
      (payload) => {
        updateMessageInUI(payload.new);
      }
    )
    .on("broadcast", { event: "typing" }, (payload) => {
      if (!payload.payload || payload.payload.user_id === currentUser.id) return;
      if (payload.payload.typing) showTyping();
      else hideTyping();
    })
    .subscribe();
}

// ============================================
// DATE DIVIDERS
// ============================================
function appendDateDivider(isoDate) {
  const container = $("messages");
  const date = new Date(isoDate);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  let label;
  if (date.toDateString() === today.toDateString()) {
    label = "Today";
  } else if (date.toDateString() === yesterday.toDateString()) {
    label = "Yesterday";
  } else {
    label = date.toLocaleDateString([], {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }

  const divider = document.createElement("div");
  divider.className = "messages-date";
  divider.innerHTML = `<span>${label}</span>`;
  container.appendChild(divider);
}

// ============================================
// MARK AS SEEN
// ============================================
async function markMessagesAsSeen(convId) {
  await supabase
    .from("messages")
    .update({ seen: true })
    .eq("conversation_id", convId)
    .neq("sender_id", currentUser.id)
    .eq("seen", false);
}

// ============================================
// UPDATE MESSAGE IN UI
// ============================================
function updateMessageInUI(newMsg) {
  const bubbles = $("messages").children;
  for (const bubble of bubbles) {
    if (bubble.dataset && bubble.dataset.msgId == newMsg.id) {
      const content = newMsg.content || "";

      if (content.startsWith("[deleted]")) {
        bubble.innerHTML = `
          <em style="color: var(--text-muted);">🗑 Message deleted</em>
          <span class="ts">${formatTime(newMsg.created_at)}</span>
        `;
        bubble.classList.add("deleted");
      } else {
        const textEl = bubble.querySelector(".bubble-text");
        if (textEl) textEl.textContent = content;
      }

      const seenCheck = bubble.querySelector(".seen-check");
      if (seenCheck && newMsg.seen) {
        seenCheck.textContent = "✓✓";
        seenCheck.style.color = "var(--online)";
      }
      break;
    }
  }
}

// ============================================
// MESSAGE ACTIONS (Edit / Delete)
// ============================================
$("messages").addEventListener("click", async (e) => {
  const target = e.target;

  if (target.closest(".btn-delete-msg")) {
    const msgId = target.closest(".btn-delete-msg").dataset.msgId;
    if (confirm("Delete this message?")) {
      await supabase
        .from("messages")
        .update({ content: "[deleted]" + Date.now() })
        .eq("id", msgId);
    }
  }

  if (target.closest(".btn-edit-msg")) {
    const msgId = target.closest(".btn-edit-msg").dataset.msgId;
    const bubble = target.closest(".bubble");
    const textEl = bubble.querySelector(".bubble-text");
    if (
      textEl &&
      !textEl.textContent.startsWith("[image]") &&
      !textEl.textContent.startsWith("[video]") &&
      !textEl.textContent.startsWith("[audio]")
    ) {
      $("message-input").value = textEl.textContent;
      editingMessageId = msgId;
      $("message-input").focus();
      $("btn-send").innerHTML = "✏️";
      showSendButton(true);
    }
  }
});

// ============================================
// MESSAGE COMPOSER
// ============================================
$("btn-attach").addEventListener("click", () => $("file-input").click());

$("file-input").addEventListener("change", async function (e) {
  const file = e.target.files[0];
  if (!file) return;
  await sendFile(file);
  this.value = "";
});

$("btn-record").addEventListener("click", async () => {
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
});

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
      const file = new File([audioBlob], "voice_note.webm", {
        type: "audio/webm",
      });
      await sendFile(file);
      stream.getTracks().forEach((t) => t.stop());
    };

    mediaRecorder.start();
    isRecording = true;

    $("btn-record").classList.add("recording");

    const indicator = document.createElement("div");
    indicator.id = "recording-indicator";
    indicator.className = "recording-indicator";
    indicator.innerHTML =
      '<span class="recording-dot"></span> Recording...';
    $("messages").appendChild(indicator);
    scrollToBottom();
  } catch (e) {
    alert("Microphone access denied");
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    $("btn-record").classList.remove("recording");

    const indicator = document.getElementById("recording-indicator");
    if (indicator) indicator.remove();
  }
}

async function sendFile(file) {
  if (!activeConversation) return;

  const fileExt = file.name.split(".").pop();
  const fileName =
    Date.now() + "_" + Math.random().toString(36).substring(2) + "." + fileExt;
  const filePath = activeConversation.id + "/" + fileName;

  const uploadResult = await supabase.storage
    .from("chat-media")
    .upload(filePath, file);

  if (uploadResult.error) {
    alert("Upload failed: " + uploadResult.error.message);
    return;
  }

  const urlResult = supabase.storage.from("chat-media").getPublicUrl(filePath);
  const mediaUrl = urlResult.data.publicUrl;
  const mediaType = file.type.split("/")[0];

  let content = "";
  if (mediaType === "image") content = "[image]" + mediaUrl;
  else if (mediaType === "video") content = "[video]" + mediaUrl;
  else if (mediaType === "audio") content = "[audio]" + mediaUrl;

  const { error } = await supabase.from("messages").insert({
    conversation_id: activeConversation.id,
    sender_id: currentUser.id,
    content,
  });

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
    const { error } = await supabase
      .from("messages")
      .update({ content, edited: true })
      .eq("id", editingMessageId);

    if (error) {
      alert("Failed to edit: " + error.message);
      return;
    }

    editingMessageId = null;
    $("btn-send").innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  } else {
    const { error } = await supabase.from("messages").insert({
      conversation_id: activeConversation.id,
      sender_id: currentUser.id,
      content,
    });

    if (error) {
      alert("Failed to send: " + error.message);
      input.value = content;
      return;
    }
  }

  input.value = "";
  sendTyping(false);
  showSendButton(false);
});

// ============================================
// TYPING INDICATORS
// ============================================
$("message-input").addEventListener("input", () => {
  if (!activeConversation) return;
  const hasText = $("message-input").value.trim().length > 0;

  if (hasText) {
    showSendButton(true);
    if (!isTypingSent) sendTyping(true);
    clearTimeout(typingTimeoutLocal);
    typingTimeoutLocal = setTimeout(() => sendTyping(false), 2000);
  } else {
    showSendButton(false);
    sendTyping(false);
  }
});

function showSendButton(show) {
  if (show) {
    $("btn-send").style.display = "";
    $("btn-record").style.display = "none";
  } else {
    $("btn-send").style.display = "none";
    $("btn-record").style.display = "";
  }
}

// Initial state
$("btn-send").style.display = "none";
$("btn-record").style.display = "";

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
    seenIcon = `
      <span class="seen-check" style="color: ${m.seen ? "var(--online)" : "var(--text-muted)"};">
        ${m.seen ? "✓✓" : "✓"}
      </span>`;
  }

  if (isDeleted) {
    div.innerHTML = `
      ${seenIcon}
      <em style="color: var(--text-muted);">🗑 Message deleted</em>
      <span class="ts">${formatTime(m.created_at)}</span>
    `;
    div.classList.add("deleted");
  } else if (content.startsWith("[image]")) {
    const url = content.replace("[image]", "");
    div.innerHTML = `
      <img src="${url}" class="msg-image" loading="lazy" alt="Image" />
      ${seenIcon}
      <span class="ts">${formatTime(m.created_at)}</span>
    `;

    div.querySelector(".msg-image")?.addEventListener("click", () => {
      $("zoom-image").src = url;
      show("image-zoom-modal");
    });
  } else if (content.startsWith("[video]")) {
    const url = content.replace("[video]", "");
    div.innerHTML = `
      <video controls class="msg-video" preload="metadata">
        <source src="${url}" type="video/mp4">
      </video>
      ${seenIcon}
      <span class="ts">${formatTime(m.created_at)}</span>
    `;
  } else if (content.startsWith("[audio]")) {
    const url = content.replace("[audio]", "");
    div.innerHTML = `
      <audio controls class="msg-audio" preload="metadata">
        <source src="${url}" type="audio/webm">
      </audio>
      ${seenIcon}
      <span class="ts">${formatTime(m.created_at)}</span>
    `;
  } else {
    const editedMark = m.edited
      ? ' <span class="edited-mark">(edited)</span>'
      : "";
    div.innerHTML = `
      ${seenIcon}
      <span class="bubble-text">${escapeHtml(content)}</span>${editedMark}
      <span class="ts">${formatTime(m.created_at)}</span>
    `;
  }

  // Add edit/delete actions for own messages
  if (m.sender_id === currentUser.id && !isDeleted) {
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "msg-actions";
    actionsDiv.innerHTML = `
      <button class="btn-edit-msg" data-msg-id="${m.id}" title="Edit">✏️</button>
      <button class="btn-delete-msg" data-msg-id="${m.id}" title="Delete">🗑</button>
    `;
    div.style.position = "relative";
    div.appendChild(actionsDiv);
  }

  $("messages").appendChild(div);
}

// ============================================
// SCROLL TO BOTTOM
// ============================================
function scrollToBottom() {
  const el = $("messages");
  if (!el) return;
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}

// ============================================
// IMAGE ZOOM
// ============================================
$("btn-close-zoom").addEventListener("click", () => hide("image-zoom-modal"));
$("image-zoom-modal").addEventListener("click", function (e) {
  if (e.target === this) hide("image-zoom-modal");
});

// Close zoom with Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hide("image-zoom-modal");
  }
});

// Double-click profile avatar to zoom
$("profile-avatar").addEventListener("dblclick", function () {
  const bg = this.style.backgroundImage;
  if (bg && bg !== "" && bg !== "none") {
    const url = bg.slice(5, -2);
    $("zoom-image").src = url;
    show("image-zoom-modal");
  }
});

// ============================================
// PEER INFO CLICK
// ============================================
$("peer-info-click").addEventListener("click", () => {
  if (activeConversation) {
    openProfile(activeConversation.peer, activeConversation);
  }
});

// ============================================
// MOBILE KEYBOARD FIX
// ============================================
(function mobileKeyboardFix() {
  const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
  if (!isMobile) return;

  const chatScreen = $("chat-screen");
  const messagesEl = $("messages");
  const inputEl = $("message-input");

  if (!chatScreen || !messagesEl || !inputEl) return;

  function setDimensions() {
    const vh = window.innerHeight;
    chatScreen.style.height = vh + "px";
    messagesEl.style.height = vh - 120 + "px";
  }

  setDimensions();

  inputEl.addEventListener("focus", () => {
    setTimeout(() => {
      const vh = window.innerHeight;
      chatScreen.style.height = vh + "px";
      messagesEl.style.height = vh - 120 + "px";
      messagesEl.scrollTop = messagesEl.scrollHeight;
      window.scrollTo(0, 0);
    }, 300);
  });

  inputEl.addEventListener("blur", () => {
    setTimeout(() => {
      setDimensions();
      window.scrollTo(0, 0);
    }, 200);
  });
})();

// ============================================
// HELPER FUNCTIONS
// ============================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c];
  });
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

function shakeElement(el) {
  el.style.animation = "none";
  el.offsetHeight; // trigger reflow
  el.style.animation = "shake 0.5s ease";
  el.addEventListener("animationend", () => {
    el.style.animation = "";
  });
}

// ============================================
// ADDITIONAL STYLES (Dynamic)
// ============================================
const dynamicStyles = document.createElement("style");
dynamicStyles.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-6px); }
    75% { transform: translateX(6px); }
  }

  .spinner {
    display: inline-block;
    width: 18px;
    height: 18px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin-right: 6px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .btn-primary:disabled {
    opacity: 0.7;
    cursor: not-allowed;
    transform: none !important;
  }
`;
document.head.appendChild(dynamicStyles);

// ============================================
// SETTINGS BUTTON PLACEHOLDER
// ============================================
$("btn-settings").addEventListener("click", () => {
  alert("Settings coming soon!");
});

// ============================================
// CHAT MENU PLACEHOLDER
// ============================================
$("btn-chat-menu").addEventListener("click", () => {
  alert("Chat menu coming soon!");
});

// ============================================
// CALL BUTTON PLACEHOLDER
// ============================================
$("btn-call").addEventListener("click", () => {
  alert("Voice/video calls coming soon!");
});

console.log("🚀 SimpleChat v2 initialized successfully!");
