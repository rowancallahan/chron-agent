// Push on this phone or computer: the Settings row and subscribing the browser. (Server: py/src/notify/push.py)
// Push is per device, so the box shows whether *this* device is on, and ticking it subscribes this browser.

NOTIFY.push = {
  row: () => {
    queueMicrotask(loadPushHere);  // once this row is on the page, check this device's push state
    return `<div class="alert-row"><label><input type="checkbox" id="push-box" data-act="push-toggle" disabled> Push on this device</label>
      <a class="quiet-link" href="iphone">(are you on an iPhone?)</a></div>`;
  },
};

// Is push on for *this* device? Ticks the box, and enables it if this browser can do push.
// If it can't (or notifications are blocked), the box just stays greyed out or unticked:
// "(are you on an iPhone?)" next to it explains the usual fix.
async function loadPushHere() {
  const box = $("#push-box");
  if (!box || !S.alerts?.push_key || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  box.disabled = false;  // usable even if the check below fails
  try {
    const sub = await currentSubscription();
    if (sub && !sameKey(sub)) { await sub.unsubscribe(); return; }  // made with an old server key: it can't work
    box.checked = Boolean(sub);
    // Make sure the server has it too (e.g. someone else signed in on this browser before): it ignores repeats.
    if (sub) api("PUT", "/api/alerts/push", { subscription: sub.toJSON() }, true);
  } catch {}
}

function sameKey(sub) {  // was this subscription made with the server's current push key?
  const theirs = sub.options?.applicationServerKey, ours = fromB64u(S.alerts.push_key);
  return !theirs || new Uint8Array(theirs).every((b, i) => b === ours[i]) && theirs.byteLength === ours.length;
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function pushOn() {
  // Ask first, straight from the tap: iPhone only shows the question if it comes right after a tap.
  if ((await Notification.requestPermission()) !== "granted") throw new Error("notifications aren't allowed for this site");
  await navigator.serviceWorker.register("sw.js");
  const reg = await navigator.serviceWorker.ready;  // iPhone: wait until it's actually running
  await (await reg.pushManager.getSubscription())?.unsubscribe();  // an old one (e.g. another key) blocks a new one
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(S.alerts.push_key) });
  if (!(await api("PUT", "/api/alerts/push", { subscription: sub.toJSON() }))) {
    await sub.unsubscribe();  // the server said no: don't leave this device looking "on"
    throw new Error(lastError);
  }
}

async function pushOff() {
  const sub = await currentSubscription();
  if (sub) { await api("DELETE", "/api/alerts/push", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
}

Object.assign(actions, {
  "push-toggle": async (box) => {
    try { await (box.checked ? pushOn() : pushOff()); renderMain(); }
    catch (err) { renderMain(); say("Couldn't turn on push: " + err.message); }
  },
});

// Keep the service worker registered so pushes keep arriving.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
