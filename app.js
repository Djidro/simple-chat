// SimpleChat - Vanilla JS + Supabase

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
let currentUser = null;
let activeConversation = null;
let messageChannel = null;
let inboxChannel = null;
let typingTimeoutLocal = null;
let typingHideTimeout = null;
let isTypingSent = false;

// ---------- Media state ----------
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

// =====================================================
// AUTH
// =====================================================
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
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
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

async function ensureProfile(authUser, fallbackName) {
  const name = authUser.user_metadata ? authUser.user_metadata.name : (fallbackName || authUser.email.split("@")[0]);
  await supabase.from("users").upsert({
    id: authUser.id,
    email: authUser.email,
    name: name,
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
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(function() {});
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
  $("me-label").textContent = currentUser.name + " — " + currentUser.email;
  $("me-label").addEventListener("click", function() {
    openProfile(currentUser, null);
  });
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

  const { data: parts } = await supabase
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", currentUser.id);

  if (!parts || parts.length === 0) {
    list.innerHTML = '<li class="empty-state"><p>No chats yet.<br>Tap ＋ to start one.</p></li>';
    return;
  }

  const ids = parts.map(function(p) { return p.conversation_id; });

  const { data: convs } = await supabase
    .from("conversation_participants")
    .select("conversation_id, user_id, users:user_id (id, name, email, last_seen)")
    .in("conversation_id", ids)
    .neq("user_id", currentUser.id);

  if (!convs) return;

  for (let i = 0; i < convs.length; i++) {
    const row = convs[i];
    const { data: lastMsg } = await supabase
      .from("messages")
      .select("content, created_at")
      .eq("conversation_id", row.conversation_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const li = document.createElement("li");
    const initial = (row.users.name || "?").charAt(0).toUpperCase();
    
    var lastText = "No messages yet";
    if (lastMsg) {
      if (lastMsg.content.startsWith("[image]")) lastText = "📷 Image";
      else if (lastMsg.content.startsWith("[video]")) lastText = "🎬 Video";
      else if (lastMsg.content.startsWith("[audio]")) lastText = "🎵 Voice note";
      else lastText = lastMsg.content;
    }
    
    li.innerHTML = '<div class="avatar" data-profile="1">' + initial + '</div>' +
      '<div class="conv-meta">' +
        '<div class="name"><span data-profile="1">' + escapeHtml(row.users.name) + '</span>' +
          '<span class="time">' + (lastMsg ? formatTime(lastMsg.created_at) : "") + '</span>' +
        '</div>' +
        '<div class="last">' + escapeHtml(lastText) + '</div>' +
      '</div>';
    
    li.addEventListener("click", function(e) {
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
let profileContext = null;

async function openProfile(user, ctx) {
  const { data: fresh } = await supabase
    .from("users").select("*").eq("id", user.id).maybeSingle();
  const u = fresh || user;
  profileContext = ctx || null;

  const avatar = $("profile-avatar");
  if (u.avatar_url) {
    avatar.style.backgroundImage = "url(" + u.avatar_url + ")";
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

$("btn-profile-close").addEventListener("click", function() {
  hide("profile-modal");
});
$("btn-profile-message").addEventListener("click", function() {
  hide("profile-modal");
  if (profileContext) openChat(profileContext);
});

function subscribeInbox() {
  if (inboxChannel) supabase.removeChannel(inboxChannel);
  inboxChannel = supabase
    .channel("inbox-" + currentUser.id)
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      function(payload) {
        loadConversations();
        if (
          payload.new.sender_id !== currentUser.id &&
          (!activeConversation || activeConversation.id !== payload.new.conversation_id)
        ) {
          var notifBody = payload.new.content;
          if (notifBody.startsWith("[image]")) notifBody = "📷 Image";
          else if (notifBody.startsWith("[video]")) notifBody = "🎬 Video";
          else if (notifBody.startsWith("[audio]")) notifBody = "🎵 Voice note";
          notify("New message", notifBody);
        }
      }
    )
    .subscribe();
}

// =====================================================
// USERS LIST
// =====================================================
document.getElementById("btn-users").addEventListener("click", function() {
  loadUsersList();
  show("users-modal");
});

document.getElementById("btn-users-close").addEventListener("click", function() {
  hide("users-modal");
});

async function loadUsersList() {
  var list = document.getElementById("users-list");
  list.innerHTML = "";
  
  var result = await supabase
    .from("users")
    .select("*")
    .neq("id", currentUser.id)
    .order("name", { ascending: true });
  
  var users = result.data || [];
  
  if (users.length === 0) {
    list.innerHTML = '<li class="empty-state"><p>No other users yet</p></li>';
    return;
  }
  
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    var li = document.createElement("li");
    var initial = (u.name || "?").charAt(0).toUpperCase();
    var status = formatPresence(u.last_seen);
    
    li.innerHTML = '<div class="avatar">' + initial + '</div>' +
      '<div class="conv-meta">' +
        '<div class="name">' + escapeHtml(u.name) + '</div>' +
        '<div class="last">' + status + '</div>' +
      '</div>';
    
    li.style.cursor = "pointer";
    
    (function(user) {
      li.addEventListener("click", async function() {
        hide("users-modal");
        await startOrOpenChat(user);
      });
    })(u);
    
    list.appendChild(li);
  }
}

async function startOrOpenChat(peer) {
  var result = await supabase
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", currentUser.id);
  
  var myIds = (result.data || []).map(function(r) { return r.conversation_id; });
  var conversationId = null;
  
  if (myIds.length > 0) {
    var sharedResult = await supabase
      .from("conversation_participants")
      .select("conversation_id")
      .eq("user_id", peer.id)
      .in("conversation_id", myIds);
    
    if (sharedResult.data && sharedResult.data.length > 0) {
      conversationId = sharedResult.data[0].conversation_id;
    }
  }
  
  if (!conversationId) {
    var newConvResult = await supabase
      .from("conversations")
      .insert({})
      .select()
      .single();
    
    if (newConvResult.error) {
      alert("Failed to create chat");
      return;
    }
    
    conversationId = newConvResult.data.id;
    
    await supabase.from("conversation_participants").insert([
      { conversation_id: conversationId, user_id: currentUser.id },
      { conversation_id: conversationId, user_id: peer.id }
    ]);
  }
  
  await loadConversations();
  openChat({ id: conversationId, peer: peer });
}

// =====================================================
// NEW CHAT
// =====================================================
$("btn-new-chat").addEventListener("click", function() {
  $("new-chat-email").value = "";
  $("new-chat-error").textContent = "";
  show("new-chat-modal");
});
$("btn-cancel-chat").addEventListener("click", function() { hide("new-chat-modal"); });

$("btn-start-chat").addEventListener("click", async function() {
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
    if (!peer) {
      $("new-chat-error").textContent = "User not found.";
      return;
    }

    const { data: mine } = await supabase
      .from("conversation_participants")
      .select("conversation_id").eq("user_id", currentUser.id);
    const myIds = (mine || []).map(function(r) { return r.conversation_id; });
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
    openChat({ id: conversationId, peer: peer });
  } catch (e) {
    $("new-chat-error").textContent = e.message;
  }
});

// =====================================================
// CHAT ROOM
// =====================================================
$("btn-back").addEventListener("click", function() {
  sendTyping(false);
  hideTyping();
  stopRecording();
  if (messageChannel) {
    supabase.removeChannel(messageChannel);
    messageChannel = null;
  }
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

  if (msgs) {
    for (let i = 0; i < msgs.length; i++) {
      appendMessage(msgs[i]);
    }
  }
  scrollToBottom();

  if (messageChannel) supabase.removeChannel(messageChannel);
  messageChannel = supabase
    .channel("conv-" + conv.id)
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "messages", filter: "conversation_id=eq." + conv.id },
      function(payload) {
        appendMessage(payload.new);
        scrollToBottom();
      }
    )
    .on("broadcast", { event: "typing" }, function(payload) {
      if (!payload.payload || payload.payload.user_id === currentUser.id) return;
      if (payload.payload.typing) showTyping();
      else hideTyping();
    })
    .subscribe();
}

// =====================================================
// COMPOSER - Messages, Files, Voice
// =====================================================
$("btn-attach").addEventListener("click", function() {
  $("file-input").click();
});

$("file-input").addEventListener("change", async function(e) {
  var file = e.target.files[0];
  if (!file) return;
  await sendFile(file);
  this.value = "";
});

$("btn-record").addEventListener("click", async function() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

async function startRecording() {
  try {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    
    mediaRecorder.ondataavailable = function(e) {
      audioChunks.push(e.data);
    };
    
    mediaRecorder.onstop = async function() {
      var audioBlob = new Blob(audioChunks, { type: "audio/webm" });
      var file = new File([audioBlob], "voice_note.webm", { type: "audio/webm" });
      await sendFile(file);
      stream.getTracks().forEach(function(t) { t.stop(); });
    };
    
    mediaRecorder.start();
    isRecording = true;
    $("btn-record").textContent = "⏹";
    $("btn-record").style.color = "var(--danger)";
    
    var indicator = document.createElement("div");
    indicator.id = "recording-indicator";
    indicator.className = "recording-indicator";
    indicator.innerHTML = "🔴 Recording...";
    $("messages").appendChild(indicator);
    scrollToBottom(true);
  } catch (e) {
    alert("Microphone access denied");
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    $("btn-record").textContent = "🎤";
    $("btn-record").style.color = "";
    
    var indicator = document.getElementById("recording-indicator");
    if (indicator) indicator.remove();
  }
}

async function sendFile(file) {
  if (!activeConversation) return;
  
  var fileExt = file.name.split(".").pop();
  var fileName = Date.now() + "_" + Math.random().toString(36).substring(2) + "." + fileExt;
  var filePath = activeConversation.id + "/" + fileName;
  
  var uploadResult = await supabase.storage
    .from("chat-media")
    .upload(filePath, file);
  
  if (uploadResult.error) {
    alert("Upload failed: " + uploadResult.error.message);
    return;
  }
  
  var urlResult = supabase.storage
    .from("chat-media")
    .getPublicUrl(filePath);
  
  var mediaUrl = urlResult.data.publicUrl;
  var mediaType = file.type.split("/")[0];
  
  var content = "";
  if (mediaType === "image") {
    content = "[image]" + mediaUrl;
  } else if (mediaType === "video") {
    content = "[video]" + mediaUrl;
  } else if (mediaType === "audio") {
    content = "[audio]" + mediaUrl;
  }
  
  var { error } = await supabase.from("messages").insert({
    conversation_id: activeConversation.id,
    sender_id: currentUser.id,
    content: content,
  });
  
  if (error) {
    alert("Failed to send: " + error.message);
  }
}

$("send-form").addEventListener("submit", async function(e) {
  e.preventDefault();
  var input = $("message-input");
  var content = input.value.trim();
  if (!content || !activeConversation) return;
  input.value = "";
  sendTyping(false);
  showSendButton(false);
  
  var { error } = await supabase.from("messages").insert({
    conversation_id: activeConversation.id,
    sender_id: currentUser.id,
    content: content,
  });
  
  if (error) {
    alert("Failed to send: " + error.message);
    input.value = content;
  }
});

$("message-input").addEventListener("input", function() {
  if (!activeConversation) return;
  var hasText = $("message-input").value.trim().length > 0;
  if (hasText) {
    showSendButton(true);
    if (!isTypingSent) sendTyping(true);
    clearTimeout(typingTimeoutLocal);
    typingTimeoutLocal = setTimeout(function() { sendTyping(false); }, 2000);
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
// Hide send button initially, show record button
$("btn-send").style.display = "none";
$("btn-record").style.display = "";

function sendTyping(typing) {
  if (!messageChannel) return;
  isTypingSent = typing;
  messageChannel.send({
    type: "broadcast",
    event: "typing",
    payload: { user_id: currentUser.id, typing: typing },
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

function appendMessage(m) {
  var div = document.createElement("div");
  div.className = "bubble " + (m.sender_id === currentUser.id ? "me" : "them");
  
  var content = m.content || "";
  
  if (content.startsWith("[image]")) {
    var url = content.replace("[image]", "");
    div.innerHTML = '<img src="' + url + '" class="msg-image" loading="lazy" />' +
      '<span class="ts">' + formatTime(m.created_at) + '</span>';
    
    div.querySelector(".msg-image").addEventListener("click", function() {
      var zoom = document.getElementById("image-zoom-modal");
      var zoomImg = document.getElementById("zoom-image");
      zoomImg.src = url;
      zoom.classList.remove("hidden");
    });
  } else if (content.startsWith("[video]")) {
    var url = content.replace("[video]", "");
    div.innerHTML = '<video controls class="msg-video" preload="metadata">' +
      '<source src="' + url + '" type="video/mp4"></video>' +
      '<span class="ts">' + formatTime(m.created_at) + '</span>';
  } else if (content.startsWith("[audio]")) {
    var url = content.replace("[audio]", "");
    div.innerHTML = '<audio controls class="msg-audio" preload="metadata">' +
      '<source src="' + url + '" type="audio/webm"></audio>' +
      '<span class="ts">' + formatTime(m.created_at) + '</span>';
  } else {
    div.innerHTML = escapeHtml(content) + '<span class="ts">' + formatTime(m.created_at) + '</span>';
  }
  
  $("messages").appendChild(div);
}

function scrollToBottom(force) {
  const el = $("messages");
  if (force) {
    el.scrollTop = el.scrollHeight;
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

// =====================================================
// PROFILE PICTURE UPLOAD
// =====================================================
document.addEventListener("DOMContentLoaded", function() {
  var profileAvatar = document.getElementById("profile-avatar");
  var avatarUpload = document.getElementById("avatar-upload");
  var profileModal = document.getElementById("profile-modal");
  
  var deleteBtn = document.createElement("button");
  deleteBtn.id = "btn-delete-avatar";
  deleteBtn.textContent = "Delete Picture";
  deleteBtn.className = "secondary";
  deleteBtn.style.cssText = "margin-top: 8px; font-size: 13px; padding: 8px; display: none;";
  
  var rowDiv = profileModal.querySelector(".row");
  if (rowDiv) {
    rowDiv.parentNode.insertBefore(deleteBtn, rowDiv);
  }
  
  if (profileAvatar && avatarUpload) {
    profileAvatar.addEventListener("click", function(e) {
      e.stopPropagation();
      avatarUpload.click();
    });

    avatarUpload.addEventListener("change", async function(e) {
      var file = e.target.files[0];
      if (!file) return;
      
      if (!currentUser) {
        alert("You must be logged in to upload a picture.");
        return;
      }
      
      var fileExt = file.name.split(".").pop();
      var fileName = currentUser.id + "." + fileExt;
      
      var uploadResult = await supabase.storage
        .from("avatars")
        .upload(fileName, file, { upsert: true });
      
      if (uploadResult.error) {
        alert("Upload failed: " + uploadResult.error.message);
        return;
      }
      
      var urlResult = supabase.storage
        .from("avatars")
        .getPublicUrl(fileName);
      
      var avatarUrl = urlResult.data.publicUrl;
      
      var updateResult = await supabase.from("users")
        .update({ avatar_url: avatarUrl })
        .eq("id", currentUser.id);
      
      if (updateResult.error) {
        alert("Failed to save avatar: " + updateResult.error.message);
        return;
      }
      
      profileAvatar.style.backgroundImage = "url(" + avatarUrl + ")";
      profileAvatar.style.backgroundSize = "cover";
      profileAvatar.textContent = "";
      deleteBtn.style.display = "inline-block";
      
      alert("Profile picture updated!");
    });
  }
  
  deleteBtn.addEventListener("click", async function() {
    if (!currentUser) return;
    if (!confirm("Delete your profile picture?")) return;
    
    var updateResult = await supabase.from("users")
      .update({ avatar_url: null })
      .eq("id", currentUser.id);
    
    if (updateResult.error) {
      alert("Failed to delete: " + updateResult.error.message);
      return;
    }
    
    profileAvatar.style.backgroundImage = "";
    profileAvatar.style.backgroundSize = "";
    profileAvatar.textContent = (currentUser.name || "?").charAt(0).toUpperCase();
    deleteBtn.style.display = "none";
    alert("Profile picture deleted!");
  });
  
  var observer = new MutationObserver(function() {
    if (!profileModal.classList.contains("hidden") && profileAvatar.style.backgroundImage && profileAvatar.style.backgroundImage !== "") {
      deleteBtn.style.display = "inline-block";
    } else {
      deleteBtn.style.display = "none";
    }
  });
  observer.observe(profileModal, { attributes: true, attributeFilter: ["class"] });

  // IMAGE ZOOM
  var zoomModal = document.getElementById("image-zoom-modal");
  var zoomImage = document.getElementById("zoom-image");
  var closeZoom = document.getElementById("btn-close-zoom");

  if (profileAvatar && zoomModal) {
    profileAvatar.addEventListener("dblclick", function() {
      if (profileAvatar.style.backgroundImage && profileAvatar.style.backgroundImage !== "") {
        var url = profileAvatar.style.backgroundImage.slice(5, -2);
        zoomImage.src = url;
        zoomModal.classList.remove("hidden");
      }
    });
  }

  if (closeZoom) {
    closeZoom.addEventListener("click", function() {
      zoomModal.classList.add("hidden");
    });
  }

  if (zoomModal) {
    zoomModal.addEventListener("click", function(e) {
      if (e.target === zoomModal) {
        zoomModal.classList.add("hidden");
      }
    });
  }
});

// =====================================================
// HELPERS
// =====================================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    var map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
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
  if (mins < 60) return "last seen " + mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return "last seen " + hrs + "h ago";
  return "last seen " + new Date(lastSeen).toLocaleDateString();
}

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body: body });
  }
}
