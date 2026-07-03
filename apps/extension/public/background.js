// OculusVault extension service worker.
//
// Its one job: receive the verified Telegram session from the link page
// (oculusvault.com/link.html — allowed via externally_connectable) and stash
// it in chrome.storage.local for the popup. It never sees keys or passwords.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (
    msg &&
    msg.type === "oculusvault-auth" &&
    typeof msg.token === "string" &&
    sender.url &&
    sender.url.startsWith("https://oculusvault.com/")
  ) {
    chrome.storage.local
      .set({
        session: {
          token: msg.token,
          userId: String(msg.userId ?? ""),
          user: msg.user ?? null,
          at: Date.now(),
        },
      })
      .then(() => sendResponse({ ok: true }));
    return true; // keep the message channel open for the async response
  }
});
